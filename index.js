const express = require("express");
const { FormSG } = require("@opengovsg/formsg-sdk");
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
const DATES = ["14 August", "15 August", "16 August"];

// In-memory counters (resets if server restarts — see note below)
const counts = {
  "14 August": 0,
  "15 August": 0,
  "16 August": 0
};
const alerted = {
  "14 August": false,
  "15 August": false,
  "16 August": false
};

// ============================================================
// FormSG SDK setup
// ============================================================
const sdk = new FormSG({ mode: "production" });

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

  // 3. Find the screening date answer
  // Adjust the question field ID or match by fieldType/question text
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

  // 4. Find extra tickets answer and parse the number
  const extraField = responses.find(r =>
    r.question && r.question.toLowerCase().includes("extra ticket")
  );

  let extraTickets = 0;
  if (extraField && extraField.answer) {
    const parsed = parseInt(extraField.answer, 10);
    if (!isNaN(parsed)) extraTickets = parsed;
  }

  // 5. Add to count (1 for the person themselves + extra tickets)
  const slotsUsed = 1 + extraTickets;
  counts[chosenDate] += slotsUsed;

  console.log(`[${chosenDate}] New submission: +${slotsUsed} pax. Total: ${counts[chosenDate]}/${MAX_PAX}`);

  // 6. Send alert if limit reached (only once per date)
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
