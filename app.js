// Tüm sohbet kodunu tek kez çalıştırmak için koruma
(function () {
  if (window.__CHAT_APP_INIT) return;
  window.__CHAT_APP_INIT = true;

  // Firebase config (senin projen)
  const firebaseConfig = {
    apiKey: "AIzaSyAG__4nFoAWy368EFicS9N108IkaBAwe2s",
    authDomain: "sohbet-b417a.firebaseapp.com",
    databaseURL:
      "https://sohbet-b417a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "sohbet-b417a",
  };

  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  // Diğer scriptler için
  window._db = db;

  // Sayfa bilgileri (user1 / user2 / ...)
  const myNameFromPage = window.MY_NAME || null;
  const peerNameFromPage = window.PEER_NAME || null;
  const userKey = window.USER_KEY || null; // "user1", "user2" ...
  const isHubUser = userKey === "user1";

  const supportsCrypto = !!(window.crypto && window.crypto.subtle);
  const textEncoder = supportsCrypto ? new TextEncoder() : null;
  const textDecoder = supportsCrypto ? new TextDecoder() : null;
  const keyStorageKey = userKey ? `chat_e2ee_${userKey}` : null;
  const sharedKeyCache = new Map();
  const pendingDecryptions = new Map();
  let peerKeyRef = null;

  const encryptionState = {
    supported: supportsCrypto,
    my: null,
    peer: null,
  };

  function bufferToBase64(buffer) {
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async function hashPublicKey(publicRaw) {
    if (!supportsCrypto) return "";
    const digest = await crypto.subtle.digest("SHA-256", publicRaw);
    return bufferToBase64(digest).slice(0, 16);
  }

  function isPasswordHashRecord(value) {
    return (
      value &&
      typeof value === "object" &&
      value.hash &&
      value.salt
    );
  }

  function isStrongPassword(value) {
    const password = (value || "").toString();
    if (password.length < 8) return false;
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSymbol = /[^A-Za-z0-9]/.test(password);
    const score =
      (hasLower ? 1 : 0) +
      (hasUpper ? 1 : 0) +
      (hasDigit ? 1 : 0) +
      (hasSymbol ? 1 : 0);
    return score >= 3;
  }

  async function derivePasswordHash(password, saltBase64, iterations) {
    if (!supportsCrypto || !textEncoder) return null;
    const salt = saltBase64
      ? new Uint8Array(base64ToBuffer(saltBase64))
      : crypto.getRandomValues(new Uint8Array(16));
    const iter = iterations || 150000;
    const key = await crypto.subtle.importKey(
      "raw",
      textEncoder.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
      key,
      256
    );
    return {
      hash: bufferToBase64(bits),
      salt: saltBase64 || bufferToBase64(salt),
      iterations: iter,
      algo: "PBKDF2",
      digest: "SHA-256",
    };
  }

  async function verifyPasswordHash(password, stored) {
    if (typeof stored === "string") {
      return password === stored;
    }
    if (!isPasswordHashRecord(stored)) return false;
    const derived = await derivePasswordHash(
      password,
      stored.salt,
      stored.iterations
    );
    return !!(derived && derived.hash === stored.hash);
  }

  async function maybeUpgradeLegacyPassword(userKeyValue, password, stored) {
    if (!userKeyValue || typeof stored !== "string") return;
    const derived = await derivePasswordHash(password);
    if (!derived) return;
    db.ref("passwords")
      .child(userKeyValue)
      .set(derived)
      .catch((err) => {
        console.error("Password upgrade error", err);
      });
  }

  function getSecurityBadge() {
    const header = document.querySelector(".chat-header");
    if (!header) return null;
    let badge = document.getElementById("securityBadge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "securityBadge";
      badge.className = "security-badge";
      header.appendChild(badge);
    }
    return badge;
  }

  function updateSecurityBadge() {
    const badge = getSecurityBadge();
    if (!badge) return;
    if (!supportsCrypto) {
      badge.textContent = "E2EE off";
      badge.className = "security-badge is-off";
      return;
    }
    if (!encryptionState.my) {
      badge.textContent = "E2EE init";
      badge.className = "security-badge is-warn";
      return;
    }
    if (!encryptionState.peer || !encryptionState.peer.publicRaw) {
      badge.textContent = "E2EE waiting";
      badge.className = "security-badge is-warn";
      return;
    }
    badge.textContent = "E2EE ready";
    badge.className = "security-badge is-on";
  }

  function updateEncryptionState() {
    updateSecurityBadge();
    resolvePendingDecryptions();
  }

  async function importPrivateKey(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );
  }

  async function importPublicKey(rawBase64) {
    const buffer = base64ToBuffer(rawBase64);
    return crypto.subtle.importKey(
      "raw",
      buffer,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );
  }

  async function loadOrCreateKeyPair() {
    if (!supportsCrypto || !keyStorageKey || !userKey) return;

    const stored = localStorage.getItem(keyStorageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.privateJwk && parsed.publicRaw) {
          const privateKey = await importPrivateKey(parsed.privateJwk);
          const publicKey = await importPublicKey(parsed.publicRaw);
          encryptionState.my = {
            privateKey,
            publicKey,
            publicRaw: parsed.publicRaw,
            kid: parsed.kid || "",
          };
          publishPublicKey(parsed.publicRaw, parsed.kid || "");
          updateEncryptionState();
          return;
        }
      } catch (err) {
        console.error("Key load error", err);
      }
    }

    try {
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
      );
      const publicRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
      const privateJwk = await crypto.subtle.exportKey(
        "jwk",
        keyPair.privateKey
      );
      const kid = await hashPublicKey(publicRaw);
      const publicRawBase64 = bufferToBase64(publicRaw);
      localStorage.setItem(
        keyStorageKey,
        JSON.stringify({
          publicRaw: publicRawBase64,
          privateJwk,
          kid,
          createdAt: Date.now(),
        })
      );
      encryptionState.my = {
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        publicRaw: publicRawBase64,
        kid,
      };
      publishPublicKey(publicRawBase64, kid);
      updateEncryptionState();
    } catch (err) {
      console.error("Key generation error", err);
    }
  }

  function publishPublicKey(publicRaw, kid) {
    if (!db || !userKey || !publicRaw) return;
    db.ref("keys")
      .child(userKey)
      .set({
        publicRaw,
        kid: kid || "",
        updatedAt: Date.now(),
      })
      .catch((err) => {
        console.error("Public key publish error", err);
      });
  }

  function setPeerKeyListener(peerKey) {
    if (!db || !peerKey) {
      encryptionState.peer = null;
      updateEncryptionState();
      return;
    }
    if (peerKeyRef) {
      peerKeyRef.off();
    }
    peerKeyRef = db.ref("keys").child(peerKey);
    peerKeyRef.on("value", async (snapshot) => {
      const val = snapshot.val() || {};
      if (!val.publicRaw) {
        encryptionState.peer = null;
        updateEncryptionState();
        return;
      }
      try {
        const publicKey = await importPublicKey(val.publicRaw);
        encryptionState.peer = {
          publicKey,
          publicRaw: val.publicRaw,
          kid: val.kid || "",
        };
        updateEncryptionState();
      } catch (err) {
        console.error("Peer key import error", err);
      }
    });
  }

  function getPeerKeyForRoom(roomId) {
    if (isHubUser) return roomId || null;
    return "user1";
  }

  function isEncryptionReady() {
    return (
      supportsCrypto &&
      encryptionState.my &&
      encryptionState.my.privateKey &&
      encryptionState.peer &&
      encryptionState.peer.publicKey
    );
  }

  async function getSharedKey(peerPublicRaw) {
    if (!supportsCrypto || !encryptionState.my || !peerPublicRaw) return null;
    if (sharedKeyCache.has(peerPublicRaw)) {
      return sharedKeyCache.get(peerPublicRaw);
    }
    const peerPublicKey = await importPublicKey(peerPublicRaw);
    const key = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerPublicKey },
      encryptionState.my.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    sharedKeyCache.set(peerPublicRaw, key);
    return key;
  }

  async function encryptPayload(kind, plainText) {
    if (!isEncryptionReady()) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getSharedKey(encryptionState.peer.publicRaw);
    if (!key) return null;
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      textEncoder.encode(plainText)
    );
    return {
      kind,
      iv: bufferToBase64(iv),
      ciphertext: bufferToBase64(cipherBuffer),
      senderPub: encryptionState.my.publicRaw,
      receiverPub: encryptionState.peer.publicRaw,
      enc: "e2ee-v1",
    };
  }

  async function decryptPayload(msg) {
    if (!supportsCrypto || !msg || !msg.ciphertext || !msg.iv) {
      return { error: "unsupported" };
    }
    if (!encryptionState.my || !encryptionState.my.privateKey) {
      return { pending: true };
    }
    const myPublicRaw = encryptionState.my.publicRaw;
    let peerPublicRaw = null;
    if (msg.senderPub && msg.receiverPub && myPublicRaw) {
      if (msg.senderPub === myPublicRaw) {
        peerPublicRaw = msg.receiverPub;
      } else if (msg.receiverPub === myPublicRaw) {
        peerPublicRaw = msg.senderPub;
      }
    }
    if (!peerPublicRaw && encryptionState.peer) {
      peerPublicRaw = encryptionState.peer.publicRaw;
    }
    if (!peerPublicRaw) return { pending: true };

    try {
      const key = await getSharedKey(peerPublicRaw);
      if (!key) return { error: "no-key" };
      const iv = new Uint8Array(base64ToBuffer(msg.iv));
      const data = base64ToBuffer(msg.ciphertext);
      const plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        data
      );
      const plainText = textDecoder.decode(plainBuffer);
      if (msg.kind === "image") {
        return { payload: { imageData: plainText } };
      }
      return { payload: { text: plainText } };
    } catch (err) {
      console.error("Decrypt error", err);
      return { error: "decrypt-failed" };
    }
  }

  function markPendingDecryption(messageKey, msg, contentEl) {
    if (!messageKey || !contentEl) return;
    pendingDecryptions.set(messageKey, { msg, contentEl });
  }

  function resolvePendingDecryptions() {
    if (!isEncryptionReady() || pendingDecryptions.size === 0) return;
    pendingDecryptions.forEach((entry, key) => {
      decryptPayload(entry.msg).then((result) => {
        if (!result || result.pending || result.error) return;
        renderPayloadContent(entry.contentEl, result.payload, key);
        pendingDecryptions.delete(key);
      });
    });
  }

  const userDisplayNames = {
    user1: "User 1",
    user2: "User 2",
    user3: "User 3",
    user4: "User 4",
    user5: "User 5",
    user6: "User 6",
    user7: "User 7",
    user8: "User 8",
    user9: "User 9",
    user10: "User 10",
  };

  // Firebase'den gelen isimler (override)
  let displayNames = { ...userDisplayNames };
  const displayNamesRef = db.ref("displayNames");
  const passwordsRef = db.ref("passwords");
  let activeUserKeys = null;

  function getUserDisplayName(key) {
    return displayNames[key] || userDisplayNames[key] || key;
  }

  function setActiveUserKeys(passwords) {
    const keys = Object.keys(passwords || {}).filter((key) => {
      if (key === "user1") return false;
      return !!passwords[key];
    });
    activeUserKeys = new Set(keys);
  }

  function isActiveUserKey(key) {
    if (!activeUserKeys) return true;
    return activeUserKeys.has(key);
  }

  function getFirstActiveUserKey() {
    if (!activeUserKeys || activeUserKeys.size === 0) return null;
    return activeUserKeys.values().next().value;
  }

  function refreshConversationTabs() {
    const container = document.getElementById("conversationTabs");
    if (!container) return null;

    const buttons = Array.from(
      container.querySelectorAll(".conversation-tab")
    );
    let firstActive = null;

    buttons.forEach((btn) => {
      const roomId = btn.getAttribute("data-room");
      if (!roomId) return;
      const isVisible = isActiveUserKey(roomId);
      btn.style.display = isVisible ? "" : "none";
      if (isVisible && !firstActive) {
        firstActive = roomId;
      }
      if (!isVisible && btn.classList.contains("active")) {
        btn.classList.remove("active");
      }
    });

    return firstActive;
  }

  function updateActiveRooms(passwords) {
    setActiveUserKeys(passwords || {});
    if (!isHubUser) return;

    const firstActive = refreshConversationTabs();
    if (!firstActive) return;

    if (!currentRoomId || !activeUserKeys.has(currentRoomId)) {
      const container = document.getElementById("conversationTabs");
      if (container) {
        const buttons = Array.from(
          container.querySelectorAll(".conversation-tab")
        );
        buttons.forEach((btn) => btn.classList.remove("active"));
        const activeBtn = buttons.find(
          (btn) => btn.getAttribute("data-room") === firstActive
        );
        if (activeBtn) {
          activeBtn.classList.add("active");
        }
      }
      switchRoom(firstActive);
    }
  }

  // DOM
  const nameInput = document.getElementById("nameInput");
  const messageInput = document.getElementById("messageInput");
  const sendButton = document.getElementById("sendButton");
  const imageButton = document.getElementById("imageButton");
  const imageInput = document.getElementById("imageInput");
  const messagesDiv = document.getElementById("messages");
  const typingIndicator = document.getElementById("typingIndicator");
  const headerTitle = document.querySelector(".chat-header h1");
  const clearChatButton = document.getElementById("clearChatButton");

  // Fotoğraf görüntüleme overlay
  const viewerOverlay = document.getElementById("viewerOverlay");
  const viewerImage = document.getElementById("viewerImage");
  const viewerCountdown = document.getElementById("viewerCountdown");
  const viewerClose = document.getElementById("viewerClose");

  let viewerTimer = null;
  let isUploadingImage = false;
  let isSendingMessage = false;
  let lastSentText = "";
  let lastSentTime = 0;
  const baseTitle = document.title;
  let unreadCount = 0;
  let toastTimer = null;
  let allowNotifications = false;
  let notificationPermissionRequested = false;

  let currentRoomId = null;
  let messagesRef = null;
  let typingRef = null;
  let typingTimeout = null;

  function getToastEl() {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    return toast;
  }

  function showToast(message) {
    if (!message) return;
    const toast = getToastEl();
    toast.textContent = message;
    toast.classList.add("toast--visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("toast--visible");
    }, 3000);
  }

  function resetUnread() {
    unreadCount = 0;
    document.title = baseTitle;
  }

  function bumpUnread() {
    unreadCount += 1;
    document.title = `${baseTitle} (${unreadCount})`;
  }

  function shouldNotify() {
    if (document.visibilityState === "hidden") return true;
    if (typeof document.hasFocus === "function") {
      return !document.hasFocus();
    }
    return false;
  }

  function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (notificationPermissionRequested) return;
    notificationPermissionRequested = true;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  function notifyUser(sender, preview) {
    if (!allowNotifications || !shouldNotify()) return;
    bumpUnread();
    const message = preview || "Yeni mesaj";
    showToast(`${sender}: ${message}`);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(sender, { body: message, icon: "logo.png" });
    }
  }

  function setupNotificationHandlers() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        resetUnread();
      }
    });
    window.addEventListener("focus", resetUnread);
    document.addEventListener(
      "click",
      () => {
        requestNotificationPermission();
      },
      { once: true }
    );
  }

  // İsimler değiştiğinde UI'ı güncelle
  displayNamesRef.on("value", (snapshot) => {
    const val = snapshot.val() || {};
    displayNames = { ...userDisplayNames, ...val };

    // Admin panel etiketleri
    const panel = document.getElementById("adminPanel");
    if (panel) {
      panel.querySelectorAll(".admin-row").forEach((row) => {
        const key = row.getAttribute("data-user");
        const labelEl = row.querySelector(".admin-user-label");
        const nameInput = row.querySelector(".admin-name-input");
        const displayName = key ? getUserDisplayName(key) : "";
        if (labelEl && key) {
          labelEl.textContent = displayName;
        }
        if (nameInput && key) {
          if (!nameInput.matches(":focus")) {
            nameInput.value = val[key] || displayName;
          }
        }
      });
    }

    // User1 sekmeleri
    const tabs = document.querySelectorAll(".conversation-tab");
    tabs.forEach((btn) => {
      const key = btn.getAttribute("data-room");
      if (key) {
        btn.textContent = getUserDisplayName(key);
      }
    });

    // User1 başlık
    if (headerTitle && isHubUser && currentRoomId) {
      headerTitle.textContent = getUserDisplayName(currentRoomId);
    }
  });

  passwordsRef.on("value", (snapshot) => {
    updateActiveRooms(snapshot.val() || {});
  });

  // Şifre zorunlu mu?
  function canUseChat() {
    if (window.REQUIRE_LOGIN) {
      return !!window.__CHAT_AUTH_OK;
    }
    return true;
  }

  // İsim belirleme
  const savedName = localStorage.getItem("chatName");
  let myName = myNameFromPage || savedName || "Anonim";

  if (nameInput && !myNameFromPage) {
    nameInput.value = myName;
  }

  function getCurrentName() {
    if (userKey && displayNames[userKey]) {
      return displayNames[userKey];
    }
    if (myNameFromPage) return myNameFromPage;
    if (nameInput) {
      const value = nameInput.value.trim();
      if (value) {
        localStorage.setItem("chatName", value);
        myName = value;
        return value;
      }
    }
    return myName;
  }

  // Başlıktaki karşı taraf ismi
  if (headerTitle && !isHubUser) {
    headerTitle.textContent =
      peerNameFromPage || headerTitle.textContent || "Netlify + Firebase Sohbet";
  }

  function getDefaultRoomId() {
    if (isHubUser) {
      const firstActive = getFirstActiveUserKey();
      return firstActive || "user2"; // User1 icin varsayilan sohbet
    }
    if (userKey) {
      return userKey; // Her user kendi odası
    }
    return "public"; // index.html için genel oda
  }

  function getRoomMessagesRef(roomId) {
    const id = roomId || currentRoomId || getDefaultRoomId();
    return db.ref("conversations").child(id).child("messages");
  }

  function getRoomTypingRef(roomId) {
    const id = roomId || currentRoomId || getDefaultRoomId();
    return db.ref("conversations").child(id).child("typing");
  }

  function getOtherParticipantName() {
    if (isHubUser) {
      if (!currentRoomId) return null;
      return getUserDisplayName(currentRoomId);
    }
    return peerNameFromPage || null;
  }

  function isMessageFromMe(msg) {
    const currentName = getCurrentName();
    return (
      msg.fromKey === userKey ||
      (!msg.fromKey && msg.name && msg.name === currentName)
    );
  }

  function getMessageSenderName(msg) {
    if (!msg) return "Mesaj";
    if (msg.fromKey && userDisplayNames[msg.fromKey]) {
      return getUserDisplayName(msg.fromKey);
    }
    return msg.name || "Bilinmeyen";
  }

  function trimPreview(text) {
    const value = (text || "").toString().trim();
    if (!value) return "";
    if (value.length <= 90) return value;
    return value.slice(0, 87) + "...";
  }

  function appendImageButton(contentEl, messageKey, imageData) {
    const button = document.createElement("button");
    button.classList.add("view-image-button");
    button.textContent = "Fotografi gor";
    button.addEventListener("click", () => {
      openViewer(messageKey, imageData);
    });
    contentEl.appendChild(button);
  }

  function renderPayloadContent(contentEl, payload, messageKey) {
    if (!contentEl || !payload) return;
    contentEl.innerHTML = "";
    if (payload.imageData) {
      appendImageButton(contentEl, messageKey, payload.imageData);
    }
    if (payload.text) {
      const textEl = document.createElement("div");
      textEl.textContent = payload.text;
      contentEl.appendChild(textEl);
    }
  }

  // METİN MESAJ GÖNDERME
  async function sendMessage() {
    if (!messageInput) return;
    if (!canUseChat()) {
      alert("Once sifreyle giris yap.");
      return;
    }
    if (!supportsCrypto) {
      alert("Bu tarayici sifreli sohbeti desteklemiyor.");
      return;
    }
    if (!isEncryptionReady()) {
      showToast("E2EE hazir degil, bekle.");
      return;
    }
    if (isSendingMessage) return;

    const name = getCurrentName();
    const text = messageInput.value.trim();
    if (!text) return;

    const now = Date.now();
    if (text === lastSentText && now - lastSentTime < 400) {
      // Cok hizli art arda ayni mesaji engelle
      return;
    }
    lastSentText = text;
    lastSentTime = now;

    isSendingMessage = true;
    if (sendButton) sendButton.disabled = true;

    try {
      const encrypted = await encryptPayload("text", text);
      if (!encrypted) {
        showToast("Sifreleme hazir degil.");
        return;
      }
      await getRoomMessagesRef().push({
        fromKey: userKey || "anon",
        name,
        timestamp: now,
        kind: encrypted.kind,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        senderPub: encrypted.senderPub,
        receiverPub: encrypted.receiverPub,
        enc: encrypted.enc,
      });

      messageInput.value = "";
      setTyping(false);
    } catch (err) {
      console.error("send message error", err);
      showToast("Mesaj gonderilemedi.");
    } finally {
      isSendingMessage = false;
      if (sendButton) sendButton.disabled = false;
    }
  }

  if (sendButton) {
    sendButton.addEventListener("click", sendMessage);
  }

  if (messageInput) {
    messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // FOTOĞRAF HAZIRLAMA (boyut küçült + base64)
  function resizeImageToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const img = new Image();

      reader.onload = (e) => {
        img.src = e.target.result;
      };
      reader.onerror = reject;

      img.onload = () => {
        let width = img.width;
        let height = img.height;
        const maxSize = 900;

        if (width > maxSize || height > maxSize) {
          const scale = Math.min(maxSize / width, maxSize / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        resolve(dataUrl);
      };

      img.onerror = reject;

      reader.readAsDataURL(file);
    });
  }

  // FOTOĞRAF GÖNDERME
  async function sendImage(file) {
    if (!canUseChat()) {
      alert("Once sifreyle giris yap.");
      return;
    }
    if (!supportsCrypto) {
      alert("Bu tarayici sifreli sohbeti desteklemiyor.");
      return;
    }
    if (!isEncryptionReady()) {
      showToast("E2EE hazir degil, bekle.");
      return;
    }

    const name = getCurrentName();
    if (!file || isUploadingImage) return;

    const maxFileSize = 20 * 1024 * 1024; // 20MB
    if (file.size > maxFileSize) {
      alert("Fotograf cok buyuk (maksimum 20MB).");
      return;
    }

    isUploadingImage = true;
    if (imageButton) imageButton.disabled = true;

    const now = Date.now();
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      const encrypted = await encryptPayload("image", dataUrl);
      if (!encrypted) {
        showToast("Sifreleme hazir degil.");
        return;
      }
      await getRoomMessagesRef().push({
        fromKey: userKey || "anon",
        name,
        timestamp: now,
        kind: encrypted.kind,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        senderPub: encrypted.senderPub,
        receiverPub: encrypted.receiverPub,
        enc: encrypted.enc,
      });
    } catch (err) {
      console.error(err);
      alert("Fotograf hazirlanirken bir hata olustu.");
    } finally {
      isUploadingImage = false;
      if (imageButton) imageButton.disabled = false;
    }
  }

  if (imageButton && imageInput) {
    imageButton.addEventListener("click", () => {
      imageInput.click();
    });

    imageInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        sendImage(file);
        imageInput.value = "";
      }
    });
  }

  // Yazıyor durumu
  function setTyping(isTyping) {
    if (!canUseChat()) return;
    if (!typingRef) return;
    const key = userKey || getCurrentName();
    if (!key) return;
    typingRef.child(key).set(isTyping);
  }

  function handleTyping() {
    setTyping(true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => setTyping(false), 1500);
  }

  if (messageInput) {
    messageInput.addEventListener("input", handleTyping);
    messageInput.addEventListener("blur", () => setTyping(false));
  }

  function attachTypingListener() {
    if (!typingRef) return;

    typingRef.on("value", (snapshot) => {
      const currentKey = userKey || getCurrentName();
      let otherTypingName = null;

      snapshot.forEach((child) => {
        const name = child.key;
        const isTyping = child.val();
        if (isTyping && name !== currentKey) {
          otherTypingName = getUserDisplayName(name);
        }
      });

      if (!typingIndicator) return;
      typingIndicator.textContent = otherTypingName
        ? `${otherTypingName} yazıyor...`
        : "";
    });
  }

  // Fotograf goruntuleme
  function closeViewer() {
    if (viewerOverlay) viewerOverlay.classList.add("hidden");
    if (viewerImage) viewerImage.src = "";
    if (viewerCountdown) viewerCountdown.textContent = "";
    if (viewerTimer) {
      clearInterval(viewerTimer);
      viewerTimer = null;
    }
  }

  function openViewer(messageKey, imageSrc) {
    if (!viewerOverlay || !viewerImage) return;

    viewerImage.src = imageSrc;
    viewerOverlay.classList.remove("hidden");

    if (viewerCountdown) viewerCountdown.textContent = "";

    if (viewerTimer) {
      clearInterval(viewerTimer);
      viewerTimer = null;
    }
  }

  if (viewerOverlay) {
    viewerOverlay.addEventListener("click", (e) => {
      if (e.target === viewerOverlay) {
        closeViewer();
      }
    });
  }

  if (viewerClose) {
    viewerClose.addEventListener("click", () => {
      closeViewer();
    });
  }

  // Mesajlar
  function renderMessage(key, msg) {
    if (!messagesDiv) return;

    const isMe = isMessageFromMe(msg);

    let messageEl = document.getElementById(`msg-${key}`);
    const isNew = !messageEl;

    if (!messageEl) {
      messageEl = document.createElement("div");
      messageEl.id = `msg-${key}`;
      messagesDiv.appendChild(messageEl);
    }

    messageEl.className = "message";
    messageEl.classList.add(isMe ? "me" : "other");

    const metaEl = document.createElement("div");
    metaEl.classList.add("message-meta");
    const date = new Date(msg.timestamp || Date.now());
    const timeStr = date.toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const senderName = getMessageSenderName(msg);
    metaEl.textContent = `${senderName} - ${timeStr}`;

    const contentEl = document.createElement("div");

    if (msg.ciphertext) {
      const placeholder = document.createElement("div");
      placeholder.className = "message-placeholder";
      placeholder.textContent = "Sifreli mesaj";
      contentEl.appendChild(placeholder);

      decryptPayload(msg).then((result) => {
        if (!result) return;
        if (result.pending) {
          markPendingDecryption(key, msg, contentEl);
          return;
        }
        if (result.error) {
          placeholder.textContent = "Sifre cozumlenemedi";
          return;
        }
        renderPayloadContent(contentEl, result.payload, key);
      });
    } else {
      if (msg.imageData) {
        appendImageButton(contentEl, key, msg.imageData);
      }
      if (msg.text) {
        const textEl = document.createElement("div");
        textEl.textContent = msg.text;
        contentEl.appendChild(textEl);
      }
    }

    messageEl.innerHTML = "";
    messageEl.appendChild(metaEl);
    messageEl.appendChild(contentEl);

    if (isNew) {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  }

  function attachMessagesListener() {
    if (!messagesRef || !messagesDiv) return;

    allowNotifications = false;
    messagesRef.once("value").then(() => {
      allowNotifications = true;
    });

    messagesRef.on("child_added", (snapshot) => {
      const msg = snapshot.val() || {};
      renderMessage(snapshot.key, msg);

      if (!allowNotifications) return;
      if (!msg || isMessageFromMe(msg)) return;

      const sender = getMessageSenderName(msg);
      if (msg.text) {
        notifyUser(sender, trimPreview(msg.text));
        return;
      }
      if (msg.imageData) {
        notifyUser(sender, "Yeni fotograf");
        return;
      }
      if (msg.ciphertext) {
        decryptPayload(msg).then((result) => {
          if (result && result.payload) {
            if (result.payload.text) {
              notifyUser(sender, trimPreview(result.payload.text));
              return;
            }
            if (result.payload.imageData) {
              notifyUser(sender, "Yeni fotograf");
              return;
            }
          }
          notifyUser(sender, "Yeni mesaj");
        });
        return;
      }
      notifyUser(sender, "Yeni mesaj");
    });

    messagesRef.on("child_changed", (snapshot) => {
      renderMessage(snapshot.key, snapshot.val());
    });

    messagesRef.on("child_removed", (snapshot) => {
      const el = document.getElementById(`msg-${snapshot.key}`);
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    });
  }

  // Aktif sohbetin tüm mesajlarını sil (sadece User1)
  function clearCurrentConversation() {
    if (!isHubUser) return;
    const roomId = currentRoomId || getDefaultRoomId();
    if (!roomId) return;
    if (
      !window.confirm(
        "Bu sohbetin tüm mesajlarını silmek istiyor musun?"
      )
    ) {
      return;
    }

    const ref = getRoomMessagesRef(roomId);
    ref
      .remove()
      .then(() => {
        if (messagesDiv) {
          messagesDiv.innerHTML = "";
        }
      })
      .catch((err) => {
        console.error("Mesajları silerken hata:", err);
      });
  }

  // Oda değiştirme (User1 için farklı kullanıcılarla sohbet geçişi)
  function switchRoom(roomId) {
    const targetRoomId = roomId || getDefaultRoomId();
    if (currentRoomId === targetRoomId && messagesRef) return;

    const prevMessagesRef = messagesRef;
    const prevTypingRef = typingRef;

    currentRoomId = targetRoomId;
    pendingDecryptions.clear();
    setPeerKeyListener(getPeerKeyForRoom(targetRoomId));
    messagesRef = getRoomMessagesRef(targetRoomId)
      .orderByChild("timestamp")
      .limitToLast(100);
    typingRef = getRoomTypingRef(targetRoomId);

    if (prevMessagesRef) prevMessagesRef.off();
    if (prevTypingRef) prevTypingRef.off();

    if (messagesDiv) {
      messagesDiv.innerHTML = "";
    }
    if (typingIndicator) {
      typingIndicator.textContent = "";
    }

    if (headerTitle && isHubUser) {
      headerTitle.textContent = getUserDisplayName(targetRoomId);
    }

    attachMessagesListener();
    attachTypingListener();
  }

  // User1 arayüzünde sohbet sekmeleri
  function initConversationTabs() {
    const container = document.getElementById("conversationTabs");
    if (!container) {
      switchRoom(getDefaultRoomId());
      return;
    }

    const buttons = Array.from(
      container.querySelectorAll(".conversation-tab")
    );
    refreshConversationTabs();

    let initialRoomId = null;

    buttons.forEach((btn) => {
      const roomId = btn.getAttribute("data-room");
      if (!roomId) return;
      if (btn.style.display === "none") return;
      if (!initialRoomId && btn.classList.contains("active")) {
        initialRoomId = roomId;
      }

      btn.addEventListener("click", () => {
        if (roomId === currentRoomId) return;
        buttons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        switchRoom(roomId);
      });
    });

    // Mouse tekerleğiyle yatay kaydırma
    container.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          container.scrollLeft += e.deltaY;
        }
      },
      { passive: false }
    );

    if (!initialRoomId) {
      const firstVisible = buttons.find(
        (btn) => btn.style.display !== "none"
      );
      if (firstVisible) {
        initialRoomId = firstVisible.getAttribute("data-room");
        firstVisible.classList.add("active");
      }
    }

    switchRoom(initialRoomId || getDefaultRoomId());
  }

  // Giriş overlay'i (şifre)
  function initLoginOverlay() {
    const overlay = document.getElementById("loginOverlay");
    const chat = document.querySelector(".chat-container");
    const passwordInput = document.getElementById("passwordInput");
    const loginButton = document.getElementById("loginButton");
    const loginError = document.getElementById("loginError");

    if (!overlay || !chat || !userKey) {
      // Bu sayfada giriş yok
      window.__CHAT_AUTH_OK = true;
      return;
    }

    const sessionKey = `chatAuthOk_${userKey}`;
    if (sessionStorage.getItem(sessionKey) === "true") {
      window.__CHAT_AUTH_OK = true;
      overlay.style.display = "none";
      chat.classList.remove("hidden-chat");
      return;
    }

    const passwordRef = db.ref("passwords").child(userKey);
    let currentPassword = null;
    let loginBusy = false;

    passwordRef.on("value", (snapshot) => {
      currentPassword = snapshot.val() || null;
    });

    async function tryLogin() {
      if (loginBusy) return;
      const value = (passwordInput && passwordInput.value.trim()) || "";
      if (!currentPassword) {
        if (!value) {
          if (loginError) {
            loginError.textContent = "Sifre gir.";
          }
          return;
        }
        if (userKey === "user1") {
          if (!supportsCrypto) {
            if (loginError) {
              loginError.textContent = "Bu tarayici sifreyi olusturamiyor.";
            }
            return;
          }
          if (!isStrongPassword(value)) {
            if (loginError) {
              loginError.textContent =
                "Sifre en az 8 karakter, buyuk/kucuk harf, rakam ve sembol icermeli.";
            }
            return;
          }

          loginBusy = true;
          if (loginButton) loginButton.disabled = true;

          try {
            const derived = await derivePasswordHash(value);
            if (!derived) {
              if (loginError) {
                loginError.textContent = "Sifre olusturulamadi.";
              }
              return;
            }
            await passwordRef.set(derived);
            window.__CHAT_AUTH_OK = true;
            sessionStorage.setItem(sessionKey, "true");
            overlay.style.display = "none";
            chat.classList.remove("hidden-chat");
            if (loginError) loginError.textContent = "";
          } catch (err) {
            console.error("setup password error", err);
            if (loginError) {
              loginError.textContent = "Sifre olusturulamadi.";
            }
          } finally {
            loginBusy = false;
            if (loginButton) loginButton.disabled = false;
          }
          return;
        }
        if (loginError) {
          loginError.textContent = "Bu kullanici icin sifre ayarlanmamis.";
        }
        return;
      }
      if (!value) {
        if (loginError) {
          loginError.textContent = "Sifre gir.";
        }
        return;
      }

      if (typeof currentPassword !== "string" && !supportsCrypto) {
        if (loginError) {
          loginError.textContent = "Bu tarayici sifreyi dogrulayamiyor.";
        }
        return;
      }

      loginBusy = true;
      if (loginButton) loginButton.disabled = true;

      try {
        const ok = await verifyPasswordHash(value, currentPassword);
        if (ok) {
          window.__CHAT_AUTH_OK = true;
          sessionStorage.setItem(sessionKey, "true");
          overlay.style.display = "none";
          chat.classList.remove("hidden-chat");
          if (loginError) loginError.textContent = "";
          if (typeof currentPassword === "string") {
            await maybeUpgradeLegacyPassword(userKey, value, currentPassword);
          }
        } else if (loginError) {
          loginError.textContent = "Sifre yanlis.";
        }
      } catch (err) {
        console.error("login error", err);
        if (loginError) loginError.textContent = "Giris yapilamadi.";
      } finally {
        loginBusy = false;
        if (loginButton) loginButton.disabled = false;
      }
    }

    if (loginButton) {
      loginButton.addEventListener("click", tryLogin);
    }
    if (passwordInput) {
      passwordInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          tryLogin();
        }
      });
    }
  }

  // User 1 tarafında şifre ayar paneli
  function initAdminPanel() {
    const panel = document.getElementById("adminPanel");
    if (!panel) return;

    const statusEl = document.getElementById("adminStatus");

    panel.querySelectorAll(".admin-row").forEach((row) => {
      const key = row.getAttribute("data-user");
      const input = row.querySelector(".admin-password-input");
      const button = row.querySelector(".admin-save-button");
      const labelEl = row.querySelector(".admin-user-label");

      if (!key || !input || !button) return;

       // Mevcut şifreyi input içinde göster
       db.ref("passwords")
         .child(key)
         .on("value", (snap) => {
           const current = snap.val();
           input.value = current || "";
         });

      button.addEventListener("click", () => {
        const value = input.value.trim();
        db.ref("passwords")
          .child(key)
          .set(value)
          .then(() => {
            if (statusEl) {
              const name = labelEl ? labelEl.textContent : key;
              statusEl.textContent = `${name} şifresi kaydedildi.`;
            }
          })
          .catch((err) => {
            if (statusEl) {
              statusEl.textContent = "Hata: " + err.message;
            }
          });
      });
    });
  }

  // Başlat
  setupNotificationHandlers();
  updateSecurityBadge();
  loadOrCreateKeyPair();
  initLoginOverlay();
  initAdminPanel();

  if (isHubUser) {
    initConversationTabs();
  } else {
    switchRoom(getDefaultRoomId());
  }
})();

