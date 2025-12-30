(function () {
  function initAdminNick() {
    var db = window._db || (window.firebase && window.firebase.database());
    if (!db) return;

    var panel = document.getElementById("adminPanel");
    if (!panel) return;

    var statusEl = document.getElementById("adminStatus");

    var rows = panel.querySelectorAll(".admin-row");
    rows.forEach(function (row) {
      var key = row.getAttribute("data-user");
      if (!key) return;

      var nameInput = row.querySelector(".admin-name-input");
      var saveButton = row.querySelector(".admin-save-button");
      var labelEl = row.querySelector(".admin-user-label");

      if (!nameInput || !saveButton) return;

      var displayNameRef = db.ref("displayNames").child(key);

      // İsteğe bağlı: ilk yüklemede mevcut ismi input'a çek
      displayNameRef
        .once("value")
        .then(function (snap) {
          var current = snap.val();
          if (current && !nameInput.value) {
            nameInput.value = current;
          }
        })
        .catch(function (err) {
          console.error(err);
        });

      saveButton.addEventListener("click", function () {
        var newName = (nameInput.value || "").trim();

        displayNameRef
          .set(newName || null)
          .then(function () {
            if (statusEl) {
              var base =
                (labelEl && labelEl.textContent) || key || "Kullanıcı";
              statusEl.textContent = base + " nick kaydedildi.";
            }
          })
          .catch(function (err) {
            if (statusEl) {
              statusEl.textContent = "Hata: " + err.message;
            }
          });
      });
    });

    var requestList = document.getElementById("requestList");
    if (requestList) {
      var requestStatus = document.getElementById("requestStatus");
      var requestRef = db.ref("userRequests");
      var availableUserKeys = [
        "user2",
        "user3",
        "user4",
        "user5",
        "user6",
        "user7",
        "user8",
        "user9",
        "user10",
      ];

      function setRequestStatus(message, isError) {
        if (!requestStatus) return;
        requestStatus.textContent = message || "";
        requestStatus.style.color = isError ? "#f97373" : "#a5b4fc";
      }

      function getAvailableSlot(names, passwords) {
        for (var i = 0; i < availableUserKeys.length; i += 1) {
          var key = availableUserKeys[i];
          var hasName = names && names[key];
          var hasPassword = passwords && passwords[key];
          if (!hasName && !hasPassword) {
            return key;
          }
        }
        return "";
      }

      function approveRequest(requestId, requestData) {
        var passwordHash = requestData && (requestData.passwordHash || requestData.password);
        if (!requestData || !requestData.name || !passwordHash) {
          setRequestStatus("Talep verisi eksik.", true);
          return Promise.resolve();
        }

        return Promise.all([
          db.ref("displayNames").once("value"),
          db.ref("passwords").once("value"),
        ])
          .then(function (results) {
            var names = results[0].val() || {};
            var passwords = results[1].val() || {};
            var slot = getAvailableSlot(names, passwords);
            if (!slot) {
              setRequestStatus("Bos slot yok.", true);
              return;
            }

            var updates = {};
            updates["displayNames/" + slot] = requestData.name;
            updates["passwords/" + slot] = passwordHash;
            updates["userRequests/" + requestId] = null;

            return db.ref().update(updates).then(function () {
              setRequestStatus(requestData.name + " icin " + slot + " acildi.");
            });
          })
          .catch(function (err) {
            setRequestStatus("Onay hatasi: " + err.message, true);
          });
      }

      function renderRequests(requests) {
        requestList.innerHTML = "";

        var keys = requests ? Object.keys(requests) : [];
        var pendingKeys = keys.filter(function (key) {
          var req = requests[key];
          return req && req.name && (req.passwordHash || req.password);
        });

        if (!pendingKeys.length) {
          var emptyEl = document.createElement("div");
          emptyEl.className = "request-empty";
          emptyEl.textContent = "Bekleyen talep yok.";
          requestList.appendChild(emptyEl);
          return;
        }

        pendingKeys.sort(function (a, b) {
          var aTime = requests[a].createdAt || 0;
          var bTime = requests[b].createdAt || 0;
          return aTime - bTime;
        });

        pendingKeys.forEach(function (key) {
          var request = requests[key];
          var card = document.createElement("div");
          card.className = "request-card";

          var nameEl = document.createElement("div");
          nameEl.className = "request-name";
          nameEl.textContent = request.name;

          var metaEl = document.createElement("div");
          metaEl.className = "request-meta";
          if (request.createdAt) {
            metaEl.textContent = new Date(request.createdAt).toLocaleString(
              "tr-TR"
            );
          } else {
            metaEl.textContent = "Tarih yok";
          }

          var actionsEl = document.createElement("div");
          actionsEl.className = "request-actions";

          var approveButton = document.createElement("button");
          approveButton.type = "button";
          approveButton.className = "request-button";
          approveButton.textContent = "Onayla";
          approveButton.addEventListener("click", function () {
            approveButton.disabled = true;
            approveRequest(key, request).then(function () {
              approveButton.disabled = false;
            });
          });

          actionsEl.appendChild(approveButton);

          card.appendChild(nameEl);
          card.appendChild(metaEl);
          card.appendChild(actionsEl);
          requestList.appendChild(card);
        });
      }

      requestRef.on("value", function (snapshot) {
        renderRequests(snapshot.val() || {});
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAdminNick);
  } else {
    initAdminNick();
  }
})();
