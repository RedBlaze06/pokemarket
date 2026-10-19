
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function getFirebaseAdmin() {
  if (getApps().length) return getApps()[0];

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Configuration serveur manquante");

  const serviceAccount = JSON.parse(raw);

  return initializeApp({
    credential: cert(serviceAccount)
  });
}

function normalizeUsername(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée." });
  }

  let createdUid = null;
  let normalized = null;

  try {
    const { username, password, firstName } = req.body || {};

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      typeof firstName !== "string"
    ) {
      return res.status(400).json({ error: "Informations manquantes." });
    }

    normalized = normalizeUsername(username);
    const cleanFirstName = firstName.trim();

    if (!/^[a-z0-9._-]{3,20}$/.test(normalized)) {
      return res.status(400).json({
        error: "Le pseudo doit contenir 3 à 20 caractères : lettres sans accents, chiffres, points, tirets ou underscores."
      });
    }

    if (normalized === "osrin.legoat") {
      return res.status(409).json({ error: "Ce pseudo est réservé." });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: "Le mot de passe doit contenir au moins 8 caractères."
      });
    }

    if (cleanFirstName.length < 1 || cleanFirstName.length > 40) {
      return res.status(400).json({ error: "Prénom invalide." });
    }

    const app = getFirebaseAdmin();
    const auth = getAuth(app);
    const db = getFirestore(app);

    // Adresse technique : elle n'est jamais affichée aux clients.
    const email = `${normalized}@pokemarket-63a1c.firebaseapp.com`;

    const userRecord = await auth.createUser({
      email,
      password,
      displayName: username.trim()
    });

    createdUid = userRecord.uid;

    const usernameRef = db.collection("usernames").doc(normalized);
    const profileRef = db.collection("users").doc(createdUid);

    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(usernameRef);

      if (existing.exists) {
        throw new Error("USERNAME_TAKEN");
      }

      transaction.create(usernameRef, {
        uid: createdUid,
        username: username.trim()
      });

      transaction.create(profileRef, {
        uid: createdUid,
        username: username.trim(),
        normalizedUsername: normalized,
        firstName: cleanFirstName,
        createdAt: new Date().toISOString()
      });
    });

    return res.status(201).json({
      success: true,
      message: "Compte créé. Tu peux maintenant te connecter."
    });
  } catch (error) {
    if (createdUid) {
      try {
        const app = getFirebaseAdmin();
        await getAuth(app).deleteUser(createdUid);
        if (normalized) {
          const db = getFirestore(app);
          const ref = db.collection("usernames").doc(normalized);
          const snap = await ref.get();
          if (snap.exists && snap.data().uid === createdUid) {
            await ref.delete();
          }
          await db.collection("users").doc(createdUid).delete();
        }
      } catch (cleanupError) {
        console.error("Échec du nettoyage du compte.");
      }
    }

    if (
      error.message === "USERNAME_TAKEN" ||
      error.code === "auth/email-already-exists"
    ) {
      return res.status(409).json({
        error: "Ce pseudo est déjà utilisé. Choisis-en un autre."
      });
    }

    console.error("Erreur d'inscription :", error.code || "erreur serveur");

    return res.status(500).json({
      error: "Inscription impossible pour le moment."
    });
  }
}
