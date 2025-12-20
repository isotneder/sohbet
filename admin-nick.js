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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAdminNick);
  } else {
    initAdminNick();
  }
})();

