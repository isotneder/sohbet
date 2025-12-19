// Tüm sohbet kodunu tek kez çalıştırmak için koruma
(function () {
  if (window.__CHAT_APP_INIT) {
    return;
  }
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

  // Sayfa isimleri (user1 / user2)
  const myNameFromPage = window.MY_NAME || null;
  const peerNameFromPage = window.PEER_NAME || null;
  const otherName = peerNameFromPage || null;

  // Şifre gerekli mi?
  function canUseChat() {
    if (!window.CHAT_PASSWORD) return true; // şifre tanımlı değilse serbest
    return !!window.__CHAT_AUTH_OK;
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

  // Başlıkta karşı tarafın adı
  if (headerTitle) {
    headerTitle.textContent = peerNameFromPage || "Netlify + Firebase Sohbet";
  }

  // İsim belirleme
  const savedName = localStorage.getItem("chatName");
  let myName = myNameFromPage || savedName || "Anonim";

  if (nameInput) {
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
      // çok hızlı art arda aynı mesajı engelle
      return;
    }
    lastSentText = text;
    lastSentTime = now;

    const expiresAt = now + 10 * 60 * 1000; // 10 dakika sonra sil

    db.ref("messages").push({
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
      alert("Fotoğraf çok büyük (max 20MB).");
      return;
    }

    isUploadingImage = true;
    if (imageButton) imageButton.disabled = true;

    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 dakika sonra sil

    resizeImageToDataUrl(file)
      .then((dataUrl) => {
        return db.ref("messages").push({
          name,
          imageData: dataUrl,
          timestamp: now,
          expiresAt,
        });
      })
      .catch((err) => {
        console.error(err);
        alert("Fotoğraf hazırlanırken hata oluştu.");
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

  // YAZIYOR DURUMU
  const typingRef = db.ref("typing");
  let typingTimeout = null;

  function setTyping(isTyping) {
    if (!canUseChat()) return;
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

  // FOTOĞRAF GÖRÜNTÜLEME (tek görünmelik, 10 saniye)
  function closeViewer() {
    if (viewerOverlay) viewerOverlay.classList.add("hidden");
    if (viewerImage) viewerImage.src = "";
    if (viewerCountdown) viewerCountdown.textContent = "";
    if (viewerTimer) {
      clearInterval(viewerTimer);
      viewerTimer = null;
    }
  }

  function openViewer(messageKey, imageSrc, viewerKey, buttonEl) {
    if (!viewerOverlay || !viewerImage) return;

    viewerImage.src = imageSrc;
    viewerOverlay.classList.remove("hidden");

    let remaining = 10;
    if (viewerCountdown) viewerCountdown.textContent = `Kalan: ${remaining} sn`;

    if (viewerKey && messageKey) {
      db
        .ref("messages")
        .child(messageKey)
        .child("seenBy")
        .child(viewerKey)
        .set(true);
    }

    // Fotoğraf açıldıktan 10 saniye sonra tamamen sil
    if (messageKey) {
      setTimeout(() => {
        db.ref("messages").child(messageKey).remove();
      }, 10000);
    }

    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = "Fotoğraf süresi doldu";
    }

    if (viewerTimer) {
      clearInterval(viewerTimer);
    }

    viewerTimer = setInterval(() => {
      remaining -= 1;
      if (viewerCountdown)
        viewerCountdown.textContent = `Kalan: ${remaining} sn`;

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

  // MESAJLARI DİNLE + GÖRÜLDÜ DURUMU
  const messagesRef = db
    .ref("messages")
    .orderByChild("timestamp")
    .limitToLast(100);

  function renderMessage(key, msg) {
    const currentName = getCurrentName();
    const viewerKey = myNameFromPage || currentName;
    const isMe = msg.name === currentName;
    const now = Date.now();

    // Süresi geçmiş mesajları sil (10 dk)
    if (msg.expiresAt && msg.expiresAt <= now) {
      db.ref("messages").child(key).remove();
      return;
    }

    // Karşıdan gelen mesajları okundu işaretle (readBy)
    if (!isMe && viewerKey) {
      const readBy = msg.readBy || {};
      if (!readBy[viewerKey]) {
        db
          .ref("messages")
          .child(key)
          .child("readBy")
          .child(viewerKey)
          .set(true);
      }
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
    metaEl.textContent = `${msg.name} • ${timeStr}`;

    const contentEl = document.createElement("div");

    const imageSrc = msg.imageData || msg.imageUrl || null;
    const seenBy = msg.seenBy || {};
    const alreadySeenPhoto = viewerKey && seenBy[viewerKey];

    if (imageSrc && !alreadySeenPhoto) {
      const button = document.createElement("button");
      button.classList.add("view-image-button");
      button.textContent = "Fotoğrafı gör (10 sn)";
      button.addEventListener("click", () => {
        openViewer(key, imageSrc, viewerKey, button);
      });
      contentEl.appendChild(button);
    } else if (imageSrc && alreadySeenPhoto) {
      const openedEl = document.createElement("div");
      openedEl.classList.add("view-image-opened");
      openedEl.textContent = "Açıldı";
      contentEl.appendChild(openedEl);
    }

    if (msg.text) {
      const textEl = document.createElement("div");
      textEl.textContent = msg.text;
      contentEl.appendChild(textEl);
    }

    // Sadece kendi gönderdiğimiz mesajlara tik ekle
    if (isMe) {
      const statusSpan = document.createElement("span");
      statusSpan.classList.add("message-status");

      let statusText = "✓";
      let statusClass = "sent";

      if (otherName && msg.readBy && msg.readBy[otherName]) {
        statusText = "✓✓";
        statusClass = "seen";
      }

      statusSpan.textContent = statusText;
      statusSpan.classList.add(statusClass);
      metaEl.appendChild(statusSpan);
    }

    messageEl.innerHTML = "";
    messageEl.appendChild(metaEl);
    messageEl.appendChild(contentEl);

    if (isNew) {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
  }

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
})();

