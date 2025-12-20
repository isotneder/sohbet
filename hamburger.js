(function () {
  function initHamburgerMenu() {
    var toggleButton = document.getElementById("menuToggle");
    var panel = document.getElementById("adminPanel");
    var closeButton = document.getElementById("menuCloseButton");
    var backdrop = document.getElementById("menuBackdrop");

    if (!toggleButton || !panel) return;

    function openMenu() {
      panel.classList.add("admin-panel--open");
      if (backdrop) {
        backdrop.classList.add("menu-backdrop--visible");
      }
      document.body.classList.add("menu-open");
    }

    function closeMenu() {
      panel.classList.remove("admin-panel--open");
      if (backdrop) {
        backdrop.classList.remove("menu-backdrop--visible");
      }
      document.body.classList.remove("menu-open");
    }

    toggleButton.addEventListener("click", function () {
      var isOpen = panel.classList.contains("admin-panel--open");
      if (isOpen) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    if (closeButton) {
      closeButton.addEventListener("click", closeMenu);
    }

    if (backdrop) {
      backdrop.addEventListener("click", closeMenu);
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panel.classList.contains("admin-panel--open")) {
        closeMenu();
      }
    });

    // Menü içindeki sohbet sekmesine tıklanınca menüyü kapat
    panel.addEventListener("click", function (e) {
      var target = e.target;
      if (
        target &&
        target.classList &&
        target.classList.contains("conversation-tab")
      ) {
        closeMenu();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHamburgerMenu);
  } else {
    initHamburgerMenu();
  }
})();

