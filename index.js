const express = require("express");
const formsg = require("@opengovsg/formsg-sdk");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION — fill these in as environment variables
// ============================================================
const FORMSG_SECRET_KEY = process.env.FORMSG_SECRET_KEY;
const FORMSG_WEBHOOK_SECRET = process.env.FORMSG_WEBHOOK_SECRET;
const ALERT_EMAIL = process.env.ALERT_EMAIL;         // email to receive alerts
const SMTP_USER = process.env.SMTP_USER;             // Gmail address used to send alerts
const SMTP_PASS = process.env.SMTP_PASS;             // Gmail app password

const MAX_PAX = 80;
const DATES = ["14th August, Friday - Night", "15th August, Saturday - Afternoon", "16th August, Sunday - Afternoon"];

// In-memory counters (resets if server restarts — see note below)
const counts = {
  "14th August, Friday - Night": 0,
  "15th August, Saturday - Afternoon": 0,
  "16th August, Sunday - Afternoon": 0
};
const alerted = {
  "14th August, Friday - Night": false,
  "15th August, Saturday - Afternoon": false,
  "16th August, Sunday - Afternoon": false
};
const seenMobileNumbers = new Map();

// ============================================================
// FormSG SDK setup
// ============================================================
const sdk = (formsg.default || formsg)({ mode: "production" });

// ============================================================
// Webhook endpoint
// ============================================================
app.post("/webhook", async (req, res) => {
  // 1. Verify the request is genuinely from FormSG
  try {
    sdk.webhooks.authenticate(
      req.headers["x-formsg-signature"],
     `https://movie-night-tracker.onrender.com/webhook`
    );
  } catch (e) {
    console.error("Webhook authentication failed:", e);
    return res.status(401).send("Unauthorized");
  }

  // 2. Decrypt the submission
  let submission;
  try {
    submission = sdk.crypto.decrypt(FORMSG_SECRET_KEY, req.body.data);
    if (!submission) throw new Error("Decryption returned null");
  } catch (e) {
    console.error("Decryption failed:", e);
    return res.status(400).send("Decryption failed");
  }

  const responses = submission.responses;

  // 3. Check for duplicate mobile number
  const mobileField = responses.find(r =>
    r.question && r.question.toLowerCase().includes("mobile")
  );
  const mobileNumber = mobileField ? mobileField.answer.trim() : null;

  if (!mobileNumber) {
    console.log("No mobile number found in submission, skipping.");
    return res.status(200).send("OK");
  }


  // 4. Find the screening date answer
  const dateField = responses.find(r =>
    r.question && r.question.toLowerCase().includes("screening date")
  );

  if (!dateField) {
    console.log("No screening date field found in submission");
    return res.status(200).send("OK");
  }

  const chosenDate = DATES.find(d => dateField.answer.includes(d));
  if (!chosenDate) {
    console.log("Chosen date not recognised:", dateField.answer);
    return res.status(200).send("OK");
  }

  // 5. Find extra tickets answer and parse the number
  const extraField = responses.find(r =>
    r.question && r.question.toLowerCase().includes("extra ticket")
  );

  let extraTickets = 0;
  if (extraField && extraField.answer) {
    const answer = extraField.answer.trim().toLowerCase();
    
    if (answer === "nil" || answer === "") {
      extraTickets = 0;
    } else if (answer === "+1") {
      extraTickets = 1;
    } else if (answer === "+2") {
      extraTickets = 2;
    } else {
      // Handle "Others" free text input - works for both numbers and words
      const wordToNumber = {
        "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
        "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
        "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
        "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
        "eighteen": 18, "nineteen": 19, "twenty": 20
      };
  
      // First check if the answer contains a word number
      let found = false;
      for (const [word, num] of Object.entries(wordToNumber)) {
        if (answer.includes(word)) {
          extraTickets = num;
          found = true;
          break;
        }
      }
  
      // If no word number found, try to extract a digit
      if (!found) {
        const parsed = parseInt(answer.replace(/\D/g, ""), 10);
        if (!isNaN(parsed)) extraTickets = parsed;
      }
    }
  }

  // 6. Register mobile number and add to count
  seenMobileNumbers.add(mobileNumber);
  const slotsUsed = 1 + extraTickets;
  counts[chosenDate] += slotsUsed;

  console.log(`[${chosenDate}] New submission: +${slotsUsed} pax. Total: ${counts[chosenDate]}/${MAX  // 6. Update count based on whether this is a new or duplicate submission
  if (seenMobileNumbers.has(mobileNumber)) {
    const previousSlots = seenMobileNumbers.get(mobileNumber);
    const newSlots = 1 + extraTickets;

    if (newSlots > previousSlots) {
      const difference = newSlots - previousSlots;
      counts[chosenDate] += difference;
      seenMobileNumbers.set(mobileNumber, newSlots);
      console.log(`[${chosenDate}] Updated submission for ${mobileNumber}: +${difference} more pax. Total: ${counts[chosenDate]}/${MAX_PAX}`);
    } else {
      console.log(`Duplicate submission for ${mobileNumber} with same or fewer tickets, skipping.`);
      return res.status(200).send("OK");
    }
  } else {
    seenMobileNumbers.set(mobileNumber, 1 + extraTickets);
    const slotsUsed = 1 + extraTickets;
    counts[chosenDate] += slotsUsed;
    console.log(`[${chosenDate}] New submission: +${slotsUsed} pax. Total: ${counts[chosenDate]}/${MAX_PAX}`);
  }

  // 7. Send alert if limit reached (only once per date)
  if (counts[chosenDate] >= MAX_PAX && !alerted[chosenDate]) {
    alerted[chosenDate] = true;
    await sendAlert(chosenDate, counts[chosenDate]);
  }

  return res.status(200).send("OK");
});

// ============================================================
// Simple status page so you can check counts anytime
// ============================================================
app.get("/status", (req, res) => {
  res.json({
    counts,
    max: MAX_PAX,
    alerted
  });
});

// ============================================================
// Email alert function
// ============================================================
async function sendAlert(date, count) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: SMTP_USER,
    to: ALERT_EMAIL,
    subject: `[Movie Night] ${date} is now FULL (${count} pax)`,
    text: `The screening on ${date} has reached or exceeded the maximum of ${MAX_PAX} pax.\n\nCurrent counts:\n${JSON.stringify(counts, null, 2)}\n\nPlease remove this date from the FormSG form manually.`
  });

  console.log(`Alert sent for ${date}`);
}

// ============================================================
// Start server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
