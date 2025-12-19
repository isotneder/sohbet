// Firebase ayarların (senin projene göre)
const firebaseConfig = {
  apiKey: "AIzaSyAG__4nFoAWy368EFicS9N108IkaBAwe2s",
  authDomain: "sohbet-b417a.firebaseapp.com",
  databaseURL:
    "https://sohbet-b417a-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "sohbet-b417a",
  storageBucket: "sohbet-b417a.firebasestorage.app",
  messagingSenderId: "952601187294",
  appId: "1:952601187294:web:e58302a19531645a2cc34f",
};

// Firebase'i başlat
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const storage = firebase.storage();

// Sayfadan gelen sabit isimler (user1.html / user2.html)
// MY_NAME: bu sayfadaki kişi
// PEER_NAME: konuştuğun kişi
const myNameFromPage = window.MY_NAME || null;
const peerNameFromPage = window.PEER_NAME || null;

// DOM elementleri
const nameInput = document.getElementById("nameInput");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const imageButton = document.getElementById("imageButton");
const imageInput = document.getElementById("imageInput");
const messagesDiv = document.getElementById("messages");
const typingIndicator = document.getElementById("typingIndicator");
const headerTitle = document.querySelector(".chat-header h1");

// Başlık: DM gibi, üstte karşı tarafın adı
if (headerTitle) {
  if (peerNameFromPage) {
    headerTitle.textContent = peerNameFromPage;
  } else {
    headerTitle.textContent = "Netlify + Firebase Sohbet";
  }
}

// İsim belirleme
const savedName = localStorage.getItem("chatName");
let myName = myNameFromPage || savedName || "Anonim";

// index.html'de isim alanı varsa doldur, DM sayfalarında olmayabilir
if (nameInput) {
  nameInput.value = myName;
}

function getCurrentName() {
  if (myNameFromPage) {
    return myNameFromPage;
  }
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

// Metin mesaj gönder
function sendMessage() {
  const name = getCurrentName();
  const text = messageInput.value.trim();
  if (!text) return;

  const msgRef = db.ref("messages").push();
  msgRef.set({
    name,
    text,
    timestamp: Date.now(),
  });

  messageInput.value = "";
  setTyping(false);
}

sendButton.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});

// Fotoğraf seç ve yükle
function sendImage(file) {
  const name = getCurrentName();
  if (!file) return;

  const maxSize = 5 * 1024 * 1024; // 5MB
  if (file.size > maxSize) {
    alert("Fotoğraf çok büyük (max 5MB).");
    return;
  }

  const path = `images/${Date.now()}_${file.name}`;
  const ref = storage.ref(path);

  ref
    .put(file)
    .then((snapshot) => snapshot.ref.getDownloadURL())
    .then((url) => {
      const msgRef = db.ref("messages").push();
      return msgRef.set({
        name,
        imageUrl: url,
        timestamp: Date.now(),
      });
    })
    .catch((err) => {
      console.error(err);
      alert("Fotoğraf yüklenirken hata oluştu.");
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
  typingTimeout = setTimeout(() => setTyping(false), 2000);
}

if (messageInput) {
  messageInput.addEventListener("input", handleTyping);
  messageInput.addEventListener("blur", () => setTyping(false));
}

// Diğer kişinin yazıyor bilgisini dinle
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

  if (otherTypingName) {
    typingIndicator.textContent = `${otherTypingName} yazıyor...`;
  } else {
    typingIndicator.textContent = "";
  }
});

// Mesajları gerçek zamanlı dinle
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

      if (msg.imageUrl) {
        const imgEl = document.createElement("img");
        imgEl.src = msg.imageUrl;
        imgEl.alt = "Gönderilen fotoğraf";
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

