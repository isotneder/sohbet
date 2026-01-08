(function () {
  if (window.__CHAT_DM_INIT) return;
  window.__CHAT_DM_INIT = true;

  const firebaseConfig = {
    apiKey: "AIzaSyAG__4nFoAWy368EFicS9N108IkaBAwe2s",
    authDomain: "sohbet-b417a.firebaseapp.com",
    databaseURL:
      "https://sohbet-b417a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "sohbet-b417a",
  };

  if (!window.firebase) return;
  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  const db = firebase.database();

  const sessionUserId = sessionStorage.getItem("chat_uid");
  const sessionUsername = sessionStorage.getItem("chat_username");
  if (!sessionUserId || !sessionUsername) {
    window.location.href = "index.html";
    return;
  }

  const currentUser = {
    id: sessionUserId,
    username: sessionUsername,
  };

  const supportsCrypto = !!(window.crypto && window.crypto.subtle);
  const textEncoder = supportsCrypto ? new TextEncoder() : null;
  const textDecoder = supportsCrypto ? new TextDecoder() : null;
  const keyStorageKey = `chat_e2ee_${currentUser.id}`;
  const sharedKeyCache = new Map();
  const pendingDecryptions = new Map();
  let peerKeyRef = null;

  const encryptionState = {
    supported: supportsCrypto,
    my: null,
    peer: null,
  };

  const messagesDiv = document.getElementById("messages");
  const typingIndicator = document.getElementById("typingIndicator");
  const headerTitle = document.querySelector(".chat-header h1");
  const conversationTabs = document.getElementById("conversationTabs");
  const searchInput = document.getElementById("searchInput");
  const startChatButton = document.getElementById("startChatButton");
  const logoutButton = document.getElementById("logoutButton");
  const imageButton = document.getElementById("imageButton");
  const imageInput = document.getElementById("imageInput");
  const messageInput = document.getElementById("messageInput");
  const sendButton = document.getElementById("sendButton");
  const conversationEmpty = document.getElementById("conversationEmpty");
  const searchSection = document.getElementById("searchSection");
  const searchResults = document.getElementById("searchResults");
  const requestList = document.getElementById("requestList");

  const viewerOverlay = document.getElementById("viewerOverlay");
  const viewerImage = document.getElementById("viewerImage");
  const viewerCountdown = document.getElementById("viewerCountdown");
  const viewerClose = document.getElementById("viewerClose");

  const userProfiles = new Map();
  const baseTitle = document.title;
  let unreadCount = 0;
  let toastTimer = null;
  let allowNotifications = false;
  let notificationPermissionRequested = false;
  let isUploadingImage = false;
  let isSendingMessage = false;

  let currentRoomId = null;
  let currentPeerId = null;
  let messagesRef = null;
  let typingRef = null;
  let typingTimeout = null;
  let approvedPeers = new Set();
  let incomingRequests = {};
  let outgoingRequests = {};
  let pendingIncoming = new Set();
  let pendingOutgoing = new Set();
  let lastSearchResults = [];
  let lastSearchQuery = "";
  let searchTimer = null;
  let searchRequestId = 0;

  function normalizeName(value) {
    return (value || "").toString().trim().toLowerCase();
  }

  function isValidUsername(value) {
    return /^[A-Za-z0-9_\u00C7\u011E\u0130\u00D6\u015E\u00DC\u00E7\u011F\u0131\u00F6\u015F\u00FC]{3,20}$/.test(
      value || ""
    );
  }

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
    if (!supportsCrypto || !keyStorageKey) return;

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
    if (!publicRaw) return;
    db.ref("keys")
      .child(currentUser.id)
      .set({
        publicRaw,
        kid: kid || "",
        updatedAt: Date.now(),
      })
      .catch((err) => {
        console.error("Public key publish error", err);
      });
  }

  function setPeerKeyListener(peerId) {
    if (!peerId) {
      encryptionState.peer = null;
      updateEncryptionState();
      return;
    }
    if (peerKeyRef) {
      peerKeyRef.off();
    }
    peerKeyRef = db.ref("keys").child(peerId);
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

  async function loadUserProfile(uid) {
    if (!uid) return null;
    if (userProfiles.has(uid)) return userProfiles.get(uid);
    try {
      const snap = await db.ref("users").child(uid).once("value");
      const val = snap.val();
      if (val) {
        userProfiles.set(uid, val);
        return val;
      }
    } catch (err) {
      console.error("user profile error", err);
    }
    return null;
  }

  function getUserNameById(uid) {
    const cached = userProfiles.get(uid);
    if (cached && cached.username) return cached.username;
    if (uid === currentUser.id) return currentUser.username;
    return "Kullanici";
  }

  function getRoomId(uidA, uidB) {
    const pair = [uidA, uidB].sort();
    return `room_${pair[0]}_${pair[1]}`;
  }

  function setHeader(peerId) {
    if (!headerTitle) return;
    if (!peerId) {
      headerTitle.textContent = "Sohbet sec";
      return;
    }
    const name = getUserNameById(peerId);
    headerTitle.textContent = name || "Sohbet";
  }

  function updateRoomMetadata(roomId, otherId, timestamp) {
    if (!roomId || !otherId) return;
    const payload = {
      otherId,
      updatedAt: timestamp || Date.now(),
    };
    const updates = {};
    updates[`userRooms/${currentUser.id}/${roomId}`] = payload;
    updates[`userRooms/${otherId}/${roomId}`] = {
      otherId: currentUser.id,
      updatedAt: payload.updatedAt,
    };
    db.ref().update(updates).catch((err) => {
      console.error("userRooms update error", err);
    });
  }

  function ensureRoomSelected() {
    if (!currentPeerId || !currentRoomId) {
      showToast("Once sohbet sec.");
      return false;
    }
    return true;
  }

  function isMessageFromMe(msg) {
    return msg && msg.fromId === currentUser.id;
  }

  function getMessageSenderName(msg) {
    if (!msg) return "Mesaj";
    if (msg.fromId) {
      return getUserNameById(msg.fromId);
    }
    return "Kullanici";
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

  async function resizeImageToDataUrl(file) {
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

  async function sendMessage() {
    if (!messageInput) return;
    if (!ensureRoomSelected()) return;
    if (!supportsCrypto) {
      alert("Bu tarayici sifreli sohbeti desteklemiyor.");
      return;
    }
    if (!isEncryptionReady()) {
      showToast("E2EE hazir degil, bekle.");
      return;
    }
    if (isSendingMessage) return;

    const text = messageInput.value.trim();
    if (!text) return;

    const now = Date.now();

    isSendingMessage = true;
    if (sendButton) sendButton.disabled = true;

    try {
      const encrypted = await encryptPayload("text", text);
      if (!encrypted) {
        showToast("Sifreleme hazir degil.");
        return;
      }
      await db
        .ref("conversations")
        .child(currentRoomId)
        .child("messages")
        .push({
          fromId: currentUser.id,
          timestamp: now,
          kind: encrypted.kind,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          senderPub: encrypted.senderPub,
          receiverPub: encrypted.receiverPub,
          enc: encrypted.enc,
        });

      updateRoomMetadata(currentRoomId, currentPeerId, now);
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

  async function sendImage(file) {
    if (!ensureRoomSelected()) return;
    if (!supportsCrypto) {
      alert("Bu tarayici sifreli sohbeti desteklemiyor.");
      return;
    }
    if (!isEncryptionReady()) {
      showToast("E2EE hazir degil, bekle.");
      return;
    }

    if (!file || isUploadingImage) return;

    const maxFileSize = 20 * 1024 * 1024;
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
      await db
        .ref("conversations")
        .child(currentRoomId)
        .child("messages")
        .push({
          fromId: currentUser.id,
          timestamp: now,
          kind: encrypted.kind,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          senderPub: encrypted.senderPub,
          receiverPub: encrypted.receiverPub,
          enc: encrypted.enc,
        });

      updateRoomMetadata(currentRoomId, currentPeerId, now);
    } catch (err) {
      console.error(err);
      alert("Fotograf hazirlanirken bir hata olustu.");
    } finally {
      isUploadingImage = false;
      if (imageButton) imageButton.disabled = false;
    }
  }

  function setTyping(isTyping) {
    if (!typingRef) return;
    typingRef.child(currentUser.id).set(isTyping);
  }

  function handleTyping() {
    setTyping(true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => setTyping(false), 1500);
  }

  function attachTypingListener() {
    if (!typingRef) return;
    typingRef.on("value", (snapshot) => {
      let otherTypingName = null;
      snapshot.forEach((child) => {
        const uid = child.key;
        const isTyping = child.val();
        if (isTyping && uid !== currentUser.id) {
          otherTypingName = getUserNameById(uid);
        }
      });

      if (!typingIndicator) return;
      typingIndicator.textContent = otherTypingName
        ? `${otherTypingName} yaziyor...`
        : "";
    });
  }

  function closeViewer() {
    if (viewerOverlay) viewerOverlay.classList.add("hidden");
    if (viewerImage) viewerImage.src = "";
    if (viewerCountdown) viewerCountdown.textContent = "";
  }

  function openViewer(messageKey, imageSrc) {
    if (!viewerOverlay || !viewerImage) return;
    viewerImage.src = imageSrc;
    viewerOverlay.classList.remove("hidden");
    if (viewerCountdown) viewerCountdown.textContent = "";
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

      if (currentRoomId && msg.fromId) {
        updateRoomMetadata(currentRoomId, msg.fromId, msg.timestamp || Date.now());
      }

      const sender = getMessageSenderName(msg);
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

  async function openConversation(peerId) {
    if (!peerId) return;
    const roomId = getRoomId(currentUser.id, peerId);

    const prevMessagesRef = messagesRef;
    const prevTypingRef = typingRef;

    currentPeerId = peerId;
    currentRoomId = roomId;
    pendingDecryptions.clear();
    setPeerKeyListener(peerId);

    messagesRef = db
      .ref("conversations")
      .child(roomId)
      .child("messages")
      .orderByChild("timestamp")
      .limitToLast(150);
    typingRef = db.ref("conversations").child(roomId).child("typing");

    if (prevMessagesRef) prevMessagesRef.off();
    if (prevTypingRef) prevTypingRef.off();

    if (messagesDiv) {
      messagesDiv.innerHTML = "";
    }
    if (typingIndicator) {
      typingIndicator.textContent = "";
    }

    await loadUserProfile(peerId);
    setHeader(peerId);
    attachMessagesListener();
    attachTypingListener();
    highlightActiveConversation(roomId);
  }

  function highlightActiveConversation(roomId) {
    if (!conversationTabs) return;
    const buttons = Array.from(
      conversationTabs.querySelectorAll(".conversation-tab")
    );
    buttons.forEach((btn) => {
      const targetRoom = btn.getAttribute("data-room");
      if (targetRoom === roomId) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  function renderConversationList(rooms) {
    if (!conversationTabs) return;
    conversationTabs.innerHTML = "";
    const entries = Object.entries(rooms || {});
    entries.sort((a, b) => {
      const aTime = (a[1] && a[1].updatedAt) || 0;
      const bTime = (b[1] && b[1].updatedAt) || 0;
      return bTime - aTime;
    });

    if (!entries.length && conversationEmpty) {
      conversationEmpty.style.display = "block";
    } else if (conversationEmpty) {
      conversationEmpty.style.display = "none";
    }

    entries.forEach(([roomId, meta]) => {
      const otherId = meta && meta.otherId;
      if (!otherId) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "conversation-tab";
      button.setAttribute("data-room", roomId);
      button.setAttribute("data-peer", otherId);
      button.textContent = getUserNameById(otherId);
      button.addEventListener("click", () => {
        openConversation(otherId);
      });
      conversationTabs.appendChild(button);
    });

    highlightActiveConversation(currentRoomId);
  }

  function setSearchSectionVisible(isVisible) {
    if (!searchSection) return;
    searchSection.style.display = isVisible ? "flex" : "none";
  }

  function renderSearchResults(results, query) {
    if (!searchResults) return;
    if (!query) {
      searchResults.innerHTML = "";
      setSearchSectionVisible(false);
      return;
    }

    setSearchSectionVisible(true);
    searchResults.innerHTML = "";
    const list = results || [];
    const filtered = list.filter(
      (user) => user && user.id && user.id !== currentUser.id
    );

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "Sonuc bulunamadi.";
      searchResults.appendChild(empty);
      return;
    }

    filtered.forEach((user) => {
      const item = document.createElement("div");
      item.className = "search-item";

      const nameEl = document.createElement("div");
      nameEl.className = "search-name";
      nameEl.textContent = user.username || "Kullanici";
      item.appendChild(nameEl);

      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.className = "search-action";

      if (approvedPeers.has(user.id)) {
        actionButton.textContent = "Sohbet ac";
        actionButton.classList.add("is-primary");
        actionButton.addEventListener("click", () => {
          openConversation(user.id);
        });
      } else if (pendingIncoming.has(user.id)) {
        actionButton.textContent = "Istek bekliyor";
        actionButton.classList.add("is-disabled");
        actionButton.disabled = true;
      } else if (pendingOutgoing.has(user.id)) {
        actionButton.textContent = "Istek gonderildi";
        actionButton.classList.add("is-disabled");
        actionButton.disabled = true;
      } else {
        actionButton.textContent = "Istek gonder";
        actionButton.addEventListener("click", () => {
          sendChatRequest(user.id);
        });
      }

      item.appendChild(actionButton);
      searchResults.appendChild(item);
    });
  }

  function renderRequestList(requests) {
    if (!requestList) return;
    requestList.innerHTML = "";
    const entries = Object.entries(requests || {});

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "request-empty";
      empty.textContent = "Istek yok.";
      requestList.appendChild(empty);
      return;
    }

    entries.sort((a, b) => {
      const aTime = (a[1] && a[1].createdAt) || 0;
      const bTime = (b[1] && b[1].createdAt) || 0;
      return bTime - aTime;
    });

    entries.forEach(([fromId]) => {
      if (!fromId) return;
      const card = document.createElement("div");
      card.className = "request-card";

      const nameEl = document.createElement("div");
      nameEl.className = "request-name";
      nameEl.textContent = getUserNameById(fromId);

      const metaEl = document.createElement("div");
      metaEl.className = "request-meta";
      metaEl.textContent = "Takip istegi";

      const actions = document.createElement("div");
      actions.className = "request-actions";

      const acceptButton = document.createElement("button");
      acceptButton.type = "button";
      acceptButton.className = "request-button";
      acceptButton.textContent = "Onayla";
      acceptButton.addEventListener("click", () => {
        approveChatRequest(fromId);
      });

      const declineButton = document.createElement("button");
      declineButton.type = "button";
      declineButton.className = "request-button";
      declineButton.textContent = "Reddet";
      declineButton.addEventListener("click", () => {
        declineChatRequest(fromId);
      });

      actions.appendChild(acceptButton);
      actions.appendChild(declineButton);
      card.appendChild(nameEl);
      card.appendChild(metaEl);
      card.appendChild(actions);
      requestList.appendChild(card);
    });
  }

  function fetchUsersByQuery(query) {
    if (!query) return Promise.resolve([]);
    return db
      .ref("users")
      .orderByChild("usernameLower")
      .startAt(query)
      .endAt(query + "\uf8ff")
      .limitToFirst(12)
      .once("value")
      .then((snapshot) => {
        const results = [];
        snapshot.forEach((child) => {
          const val = child.val();
          if (!val) return;
          const record = {
            id: child.key,
            username: val.username || "",
            usernameLower: val.usernameLower || "",
          };
          results.push(record);
          userProfiles.set(child.key, val);
        });
        return results;
      });
  }

  function performSearch() {
    if (!searchInput) return;
    const rawQuery = searchInput.value.trim();
    if (!rawQuery) {
      lastSearchResults = [];
      lastSearchQuery = "";
      renderSearchResults([], "");
      return;
    }

    const query = normalizeName(rawQuery);
    if (!query) {
      lastSearchResults = [];
      lastSearchQuery = "";
      renderSearchResults([], "");
      return;
    }

    const requestId = ++searchRequestId;
    fetchUsersByQuery(query)
      .then((results) => {
        if (requestId !== searchRequestId) return;
        lastSearchResults = results || [];
        lastSearchQuery = rawQuery;
        renderSearchResults(lastSearchResults, rawQuery);
      })
      .catch((err) => {
        console.error("user search error", err);
        showToast("Arama yapilamadi.");
      });
  }

  function scheduleSearch() {
    if (!searchInput) return;
    if (searchTimer) clearTimeout(searchTimer);
    if (!searchInput.value.trim()) {
      lastSearchResults = [];
      lastSearchQuery = "";
      renderSearchResults([], "");
      return;
    }
    searchTimer = setTimeout(() => {
      performSearch();
    }, 250);
  }

  function sendChatRequest(targetId) {
    if (!targetId || targetId === currentUser.id) return;
    if (approvedPeers.has(targetId)) {
      showToast("Zaten takiptesin.");
      return;
    }
    if (pendingIncoming.has(targetId)) {
      showToast("Bu kullanicidan istek var.");
      return;
    }
    if (pendingOutgoing.has(targetId)) {
      showToast("Istek zaten gonderildi.");
      return;
    }
    const now = Date.now();
    const updates = {};
    updates[`chatRequests/${targetId}/${currentUser.id}`] = {
      fromId: currentUser.id,
      createdAt: now,
    };
    updates[`chatRequestsSent/${currentUser.id}/${targetId}`] = {
      toId: targetId,
      createdAt: now,
    };
    pendingOutgoing.add(targetId);
    renderSearchResults(lastSearchResults, lastSearchQuery);
    db.ref()
      .update(updates)
      .then(() => {
        showToast("Istek gonderildi.");
      })
      .catch((err) => {
        console.error("request send error", err);
        pendingOutgoing.delete(targetId);
        renderSearchResults(lastSearchResults, lastSearchQuery);
        showToast("Istek gonderilemedi.");
      });
  }

  function approveChatRequest(fromId) {
    if (!fromId) return;
    const now = Date.now();
    const roomId = getRoomId(currentUser.id, fromId);
    const updates = {};
    updates[`chatRequests/${currentUser.id}/${fromId}`] = null;
    updates[`chatRequestsSent/${fromId}/${currentUser.id}`] = null;
    updates[`chatRequests/${fromId}/${currentUser.id}`] = null;
    updates[`chatRequestsSent/${currentUser.id}/${fromId}`] = null;
    updates[`userRooms/${currentUser.id}/${roomId}`] = {
      otherId: fromId,
      updatedAt: now,
    };
    updates[`userRooms/${fromId}/${roomId}`] = {
      otherId: currentUser.id,
      updatedAt: now,
    };
    db.ref()
      .update(updates)
      .then(() => {
        showToast("Istek onaylandi.");
      })
      .catch((err) => {
        console.error("request approve error", err);
        showToast("Istek onaylanamadi.");
      });
  }

  function declineChatRequest(fromId) {
    if (!fromId) return;
    const updates = {};
    updates[`chatRequests/${currentUser.id}/${fromId}`] = null;
    updates[`chatRequestsSent/${fromId}/${currentUser.id}`] = null;
    updates[`chatRequests/${fromId}/${currentUser.id}`] = null;
    updates[`chatRequestsSent/${currentUser.id}/${fromId}`] = null;
    db.ref()
      .update(updates)
      .then(() => {
        showToast("Istek reddedildi.");
      })
      .catch((err) => {
        console.error("request decline error", err);
        showToast("Istek reddedilemedi.");
      });
  }

  setSearchSectionVisible(false);

  if (startChatButton) {
    startChatButton.addEventListener("click", performSearch);
  }

  if (searchInput) {
    searchInput.addEventListener("input", scheduleSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      sessionStorage.removeItem("chat_uid");
      sessionStorage.removeItem("chat_username");
      window.location.href = "index.html";
    });
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
    messageInput.addEventListener("input", handleTyping);
    messageInput.addEventListener("blur", () => setTyping(false));
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

  db.ref("chatRequests")
    .child(currentUser.id)
    .on("value", async (snapshot) => {
      incomingRequests = snapshot.val() || {};
      pendingIncoming = new Set(Object.keys(incomingRequests));
      const requesters = Object.keys(incomingRequests);
      await Promise.all(requesters.map((peerId) => loadUserProfile(peerId)));
      renderRequestList(incomingRequests);
      renderSearchResults(lastSearchResults, lastSearchQuery);
    });

  db.ref("chatRequestsSent")
    .child(currentUser.id)
    .on("value", (snapshot) => {
      outgoingRequests = snapshot.val() || {};
      pendingOutgoing = new Set(Object.keys(outgoingRequests));
      renderSearchResults(lastSearchResults, lastSearchQuery);
    });

  db.ref("userRooms")
    .child(currentUser.id)
    .on("value", async (snapshot) => {
      const rooms = snapshot.val() || {};
      const peers = Object.values(rooms)
        .map((item) => item && item.otherId)
        .filter(Boolean);
      approvedPeers = new Set(peers);
      await Promise.all(peers.map((peerId) => loadUserProfile(peerId)));
      renderConversationList(rooms);
      renderSearchResults(lastSearchResults, lastSearchQuery);
      if (!currentRoomId && peers.length) {
        openConversation(peers[0]);
      } else if (!peers.length) {
        setHeader(null);
      }
    });

  setupNotificationHandlers();
  updateSecurityBadge();
  loadOrCreateKeyPair();
  setHeader(null);
})();
