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

  function getUserDisplayName(key) {
    return userDisplayNames[key] || key;
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

  // Fotoğraf görüntüleme overlay
  const viewerOverlay = document.getElementById("viewerOverlay");
  const viewerImage = document.getElementById("viewerImage");
  const viewerCountdown = document.getElementById("viewerCountdown");
  const viewerClose = document.getElementById("viewerClose");

  let viewerTimer = null;
  let isUploadingImage = false;
  let lastSentText = "";
  let lastSentTime = 0;

  let currentRoomId = null;
  let messagesRef = null;
  let typingRef = null;
  let typingTimeout = null;

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
      return "user2"; // User1 için varsayılan sohbet
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

  // METİN MESAJ GÖNDERME
  function sendMessage() {
    if (!messageInput) return;
    if (!canUseChat()) {
      alert("Önce şifreyle giriş yap.");
      return;
    }

    const name = getCurrentName();
    const text = messageInput.value.trim();
    if (!text) return;

    const now = Date.now();
    if (text === lastSentText && now - lastSentTime < 400) {
      // Çok hızlı art arda aynı mesajı engelle
      return;
    }
    lastSentText = text;
    lastSentTime = now;

    const expiresAt = now + 10 * 60 * 1000; // 10 dakika sonra otomatik sil

    getRoomMessagesRef().push({
      fromKey: userKey || "anon",
      name,
      text,
      timestamp: now,
      expiresAt,
    });

    messageInput.value = "";
    setTyping(false);
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
  function sendImage(file) {
    if (!canUseChat()) {
      alert("Önce şifreyle giriş yap.");
      return;
    }

    const name = getCurrentName();
    if (!file || isUploadingImage) return;

    const maxFileSize = 20 * 1024 * 1024; // 20MB
    if (file.size > maxFileSize) {
      alert("Fotoğraf çok büyük (maksimum 20MB).");
      return;
    }

    isUploadingImage = true;
    if (imageButton) imageButton.disabled = true;

    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 dakika

    resizeImageToDataUrl(file)
      .then((dataUrl) => {
        return getRoomMessagesRef().push({
          fromKey: userKey || "anon",
          name,
          imageData: dataUrl,
          timestamp: now,
          expiresAt,
        });
      })
      .catch((err) => {
        console.error(err);
        alert("Fotoğraf hazırlanırken bir hata oluştu.");
      })
      .finally(() => {
        isUploadingImage = false;
        if (imageButton) imageButton.disabled = false;
      });
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
    const name = getCurrentName();
    const key = myNameFromPage || name;
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
      const currentName = getCurrentName();
      let otherTypingName = null;

      snapshot.forEach((child) => {
        const name = child.key;
        const isTyping = child.val();
        if (isTyping && name !== currentName) {
          otherTypingName = name;
        }
      });

      if (!typingIndicator) return;
      typingIndicator.textContent = otherTypingName
        ? `${otherTypingName} yazıyor...`
        : "";
    });
  }

  // Fotoğraf görüntüleme (tek görünmelik, 10 saniye)
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

    let remaining = 10;
    if (viewerCountdown) viewerCountdown.textContent = `Kalan: ${remaining} sn`;

    // 10 saniye sonra mesajı tamamen sil
    if (messageKey) {
      const root = getRoomMessagesRef();
      setTimeout(() => {
        root.child(messageKey).remove();
      }, 10000);
    }

    if (viewerTimer) {
      clearInterval(viewerTimer);
    }

    viewerTimer = setInterval(() => {
      remaining -= 1;
      if (viewerCountdown) {
        viewerCountdown.textContent = `Kalan: ${remaining} sn`;
      }
      if (remaining <= 0) {
        closeViewer();
      }
    }, 1000);
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

    const currentName = getCurrentName();
    const isMe =
      msg.fromKey === userKey ||
      (!msg.fromKey && msg.name && msg.name === currentName);

    const now = Date.now();
    if (msg.expiresAt && msg.expiresAt <= now) {
      getRoomMessagesRef().child(key).remove();
      return;
    }

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
    metaEl.textContent = `${msg.name || "Bilinmeyen"} · ${timeStr}`;

    const contentEl = document.createElement("div");

    if (msg.imageData) {
      const button = document.createElement("button");
      button.classList.add("view-image-button");
      button.textContent = "Fotoğrafı gör (10 sn)";
      button.addEventListener("click", () => {
        button.disabled = true;
        openViewer(key, msg.imageData);
      });
      contentEl.appendChild(button);
    }

    if (msg.text) {
      const textEl = document.createElement("div");
      textEl.textContent = msg.text;
      contentEl.appendChild(textEl);
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

    messagesRef.on("child_added", (snapshot) => {
      renderMessage(snapshot.key, snapshot.val());
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

  // Oda değiştirme (User1 için farklı kullanıcılarla sohbet geçişi)
  function switchRoom(roomId) {
    const targetRoomId = roomId || getDefaultRoomId();
    if (currentRoomId === targetRoomId && messagesRef) return;

    const prevMessagesRef = messagesRef;
    const prevTypingRef = typingRef;

    currentRoomId = targetRoomId;
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

    let initialRoomId = null;

    buttons.forEach((btn) => {
      const roomId = btn.getAttribute("data-room");
      if (!roomId) return;
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

    if (!initialRoomId && buttons.length > 0) {
      initialRoomId = buttons[0].getAttribute("data-room");
      buttons[0].classList.add("active");
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

    passwordRef.on("value", (snapshot) => {
      currentPassword = snapshot.val() || "";
    });

    function tryLogin() {
      const value = (passwordInput && passwordInput.value.trim()) || "";
      if (!currentPassword) {
        if (loginError) {
          loginError.textContent =
            "Bu kullanıcı için şifre ayarlanmamış.";
        }
        return;
      }

      if (value === currentPassword) {
        window.__CHAT_AUTH_OK = true;
        sessionStorage.setItem(sessionKey, "true");
        overlay.style.display = "none";
        chat.classList.remove("hidden-chat");
        if (loginError) loginError.textContent = "";
      } else if (loginError) {
        loginError.textContent = "Şifre yanlış.";
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
  initLoginOverlay();
  initAdminPanel();

  if (isHubUser) {
    initConversationTabs();
  } else {
    switchRoom(getDefaultRoomId());
  }
})();
