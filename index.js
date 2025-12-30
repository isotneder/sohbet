const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();

const REGION = "europe-west1";
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const HASH_ITERATIONS = 120000;

function handleCors(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

function encodeKey(value) {
  return (value || "")
    .toString()
    .replace(/\./g, ",")
    .replace(/#/g, ",")
    .replace(/\$/g, ",")
    .replace(/\//g, ",")
    .replace(/\[/g, ",")
    .replace(/\]/g, ",");
}

function normalizeEmail(email) {
  return (email || "").toString().trim().toLowerCase();
}

function normalizeUsername(username) {
  return (username || "").toString().trim();
}

function isValidEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || "");
}

function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username || "");
}

function getSmtpConfig() {
  const config = typeof functions.config === "function" ? functions.config() : {};
  const smtp = (config && config.smtp) || {};
  return {
    user: process.env.SMTP_USER || smtp.user || "",
    pass: process.env.SMTP_PASS || smtp.pass || "",
    from: process.env.SMTP_FROM || smtp.from || "",
  };
}

function createTransport() {
  const smtp = getSmtpConfig();
  if (!smtp.user || !smtp.pass) {
    return { transporter: null, from: "" };
  }
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });
  return { transporter, from: smtp.from || smtp.user };
}

function hashCode(code, salt, iterations) {
  const iter = iterations || HASH_ITERATIONS;
  return crypto
    .pbkdf2Sync(code, salt, iter, 32, "sha256")
    .toString("base64");
}

function timingSafeEqualBase64(a, b) {
  const aBuf = Buffer.from(a || "", "base64");
  const bBuf = Buffer.from(b || "", "base64");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function sanitizePasswordHash(value) {
  if (!value || typeof value !== "object") return null;
  const hash = typeof value.hash === "string" ? value.hash : "";
  const salt = typeof value.salt === "string" ? value.salt : "";
  const iterations = Number(value.iterations || 0);
  if (!hash || !salt) return null;
  if (!Number.isFinite(iterations) || iterations < 50000 || iterations > 500000) {
    return null;
  }
  if (hash.length > 256 || salt.length > 128) return null;
  return {
    hash,
    salt,
    iterations,
    algo: "PBKDF2",
    digest: "SHA-256",
  };
}

exports.sendEmailCode = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    if (handleCors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ message: "Method not allowed." });
      return;
    }

    const email = normalizeEmail(req.body && req.body.email);
    if (!isValidEmail(email)) {
      res.status(400).json({ message: "E-posta gecersiz." });
      return;
    }

    const { transporter, from } = createTransport();
    if (!transporter) {
      res.status(500).json({ message: "SMTP ayarlanmamis." });
      return;
    }

    const now = Date.now();
    const emailKey = encodeKey(email);
    const codeRef = admin.database().ref("emailCodes").child(emailKey);

    try {
      const existingSnap = await codeRef.once("value");
      const existing = existingSnap.val();
      if (existing && existing.nextAllowedAt && existing.nextAllowedAt > now) {
        res.status(429).json({ message: "Kod zaten gonderildi. Biraz bekle." });
        return;
      }

      const code = crypto.randomInt(100000, 1000000).toString();
      const salt = crypto.randomBytes(16).toString("base64");
      const codeHash = hashCode(code, salt, HASH_ITERATIONS);

      await codeRef.set({
        codeHash,
        salt,
        iterations: HASH_ITERATIONS,
        createdAt: now,
        expiresAt: now + CODE_TTL_MS,
        attempts: 0,
        nextAllowedAt: now + RESEND_COOLDOWN_MS,
      });

      await transporter.sendMail({
        from,
        to: email,
        subject: "Sohbet dogrulama kodu",
        text:
          "Sohbet dogrulama kodun: " +
          code +
          "\nBu kod 10 dakika gecerli.",
      });

      res.json({ ok: true });
    } catch (err) {
      console.error("sendEmailCode error", err);
      try {
        await codeRef.remove();
      } catch (cleanupError) {
        console.error("sendEmailCode cleanup error", cleanupError);
      }
      res.status(500).json({ message: "Kod gonderilemedi." });
    }
  });

exports.verifyEmailCode = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    if (handleCors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ message: "Method not allowed." });
      return;
    }

    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const username = normalizeUsername(body.username);
    const usernameLower = username.toLowerCase();
    const code = (body.code || "").toString().trim();
    const passwordHash = sanitizePasswordHash(body.passwordHash);

    if (!isValidEmail(email)) {
      res.status(400).json({ message: "E-posta gecersiz." });
      return;
    }
    if (!isValidUsername(username)) {
      res.status(400).json({ message: "Kullanici adi gecersiz." });
      return;
    }
    if (!/^[0-9]{6}$/.test(code)) {
      res.status(400).json({ message: "Kod gecersiz." });
      return;
    }
    if (!passwordHash) {
      res.status(400).json({ message: "Sifre dogrulanamadi." });
      return;
    }

    const emailKey = encodeKey(email);
    const codeRef = admin.database().ref("emailCodes").child(emailKey);

    try {
      const codeSnap = await codeRef.once("value");
      const record = codeSnap.val();

      if (!record) {
        res.status(400).json({ message: "Kod bulunamadi." });
        return;
      }
      if (!record.codeHash || !record.salt) {
        await codeRef.remove();
        res.status(400).json({ message: "Kod gecersiz." });
        return;
      }

      const now = Date.now();
      if (record.expiresAt && record.expiresAt < now) {
        await codeRef.remove();
        res.status(400).json({ message: "Kodun suresi doldu." });
        return;
      }

      if (record.attempts && record.attempts >= MAX_ATTEMPTS) {
        res.status(429).json({ message: "Cok fazla deneme yapildi." });
        return;
      }

      const iter = Number(record.iterations) || HASH_ITERATIONS;
      const expectedHash = hashCode(code, record.salt || "", iter);
      if (!timingSafeEqualBase64(expectedHash, record.codeHash || "")) {
        await codeRef.update({
          attempts: (record.attempts || 0) + 1,
        });
        res.status(400).json({ message: "Kod hatali." });
        return;
      }

      const [usernameSnap, emailSnap] = await Promise.all([
        admin.database().ref("usernames").child(usernameLower).once("value"),
        admin.database().ref("emailIndex").child(emailKey).once("value"),
      ]);

      if (usernameSnap.exists()) {
        res.status(409).json({ message: "Bu kullanici adi kullaniliyor." });
        return;
      }
      if (emailSnap.exists()) {
        res.status(409).json({ message: "Bu e-posta kullaniliyor." });
        return;
      }

      const uid = admin.database().ref("users").push().key;
      if (!uid) {
        res.status(500).json({ message: "Hesap olusturulamadi." });
        return;
      }

      const createdAt = Date.now();
      const updates = {};
      updates[`users/${uid}`] = {
        username,
        usernameLower,
        email,
        createdAt,
      };
      updates[`usernames/${usernameLower}`] = uid;
      updates[`emailIndex/${emailKey}`] = uid;
      updates[`passwords/${uid}`] = passwordHash;
      updates[`emailCodes/${emailKey}`] = null;

      await admin.database().ref().update(updates);

      res.json({ ok: true, uid, username });
    } catch (err) {
      console.error("verifyEmailCode error", err);
      res.status(500).json({ message: "Dogrulama basarisiz." });
    }
  });
