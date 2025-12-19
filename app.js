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

// Sabit isimler (user1 / user2 sayfalarından gelebilir)
const myNameFromPage = window.MY_NAME || null;
const peerNameFromPage = window.PEER_NAME || null;

// DOM
const nameInput = document.getElementById("nameInput");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const imageButton = document.getElementById("imageButton");
const imageInput = document.getElementById("imageInput");
const messagesDiv = document.getElementById("messages");
const typingIndicator = document.getElementById("typingIndicator");
const headerTitle = document.querySelector(".chat-header h1");

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

// Metin mesaj
function sendMessage() {
  const name = getCurrentName();
  const text = messageInput.value.trim();
  if (!text) return;

  db.ref("messages").push({
    name,
    text,
    timestamp: Date.now(),
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

// Fotoğrafı base64 olarak DB'ye kaydet (Storage kullanmıyoruz)
function sendImage(file) {
  const name = getCurrentName();
  if (!file) return;

  const maxSize = 2 * 1024 * 1024; // 2MB
  if (file.size > maxSize) {
    alert("Fotoğraf çok büyük (max 2MB).");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;

    db.ref("messages").push({
      name,
      imageData: dataUrl,
      timestamp: Date.now(),
    });
  };
  reader.readAsDataURL(file);
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
const typingRef = db.ref("typing");
let typingTimeout = null;

function setTyping(isTyping) {
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

// Mesajları dinle
db.ref("messages")
  .orderByChild("timestamp")
  .limitToLast(100)
  .on("value", (snapshot) => {
    const currentName = getCurrentName();
    messagesDiv.innerHTML = "";

    snapshot.forEach((child) => {
      const msg = child.val();
      const isMe = msg.name === currentName;

      const messageEl = document.createElement("div");
      messageEl.classList.add("message");
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

      if (msg.imageData) {
        const imgEl = document.createElement("img");
        imgEl.src = msg.imageData;
        imgEl.alt = "Fotoğraf";
        imgEl.classList.add("message-image");
        contentEl.appendChild(imgEl);
      }

      if (msg.text) {
        const textEl = document.createElement("div");
        textEl.textContent = msg.text;
        contentEl.appendChild(textEl);
      }

      messageEl.appendChild(metaEl);
      messageEl.appendChild(contentEl);
      messagesDiv.appendChild(messageEl);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    });
  });

