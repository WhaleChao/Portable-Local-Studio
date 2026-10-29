import React, { memo, useState, useRef, useEffect } from "react";
import { Square, RefreshCw, Sun, Moon, Palette, Check, PanelLeft } from "lucide-react";
import { THEMES } from "../themes";

const truncateModelName = (name) => {
  if (!name || typeof name !== "string") return "";
  let cleanName = name;
  if (name.includes("--")) {
    const parts = name.split("--");
    cleanName = parts[parts.length - 1];
  }
  if (cleanName.length > 25) {
    return cleanName.substring(0, 22) + "...";
  }
  return cleanName;
};

function TopStatusBar({ 
  serverRunning, 
  activeModel, 
  isLlmLoaded = false, 
  onStopServer, 
  isStoppingServer = false, 
  theme, 
  setTheme,
  sidebarVisible,
  onToggleSidebar
}) {
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowThemeMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getStatusText = () => {
    if (isLlmLoaded || activeModel) return "Model loaded";
    if (serverRunning) return "Server running";
    return "Running locally";
  };

  const getStatusClass = () => {
    if (activeModel || isLlmLoaded) return "status-indicator";
    if (serverRunning) return "status-indicator busy";
    return "status-indicator offline";
  };

  const isDark = (theme || "dark").startsWith("dark");

  return (
    <div className="top-status-bar">
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {!sidebarVisible && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="sidebar-toggle-btn"
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            <PanelLeft size={18} />
          </button>
        )}

        <div className="current-model-info status-pill">
          <div className={getStatusClass()}></div>
          <span>{getStatusText()}</span>
          {(activeModel || (typeof isLlmLoaded === "string" && isLlmLoaded)) && (
            <span className="status-pill-model" title={activeModel || isLlmLoaded}>
              · {truncateModelName(activeModel || isLlmLoaded)}
            </span>
          )}
        </div>
      </div>

      <div className="telemetry-group" style={{ position: "relative" }}>
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
          title={`Switch to ${isDark ? "light" : "dark"} theme`}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
          <button
            type="button"
            aria-label="Choose a color theme"
            aria-expanded={showThemeMenu}
            className={`theme-toggle-btn ${showThemeMenu ? "active" : ""}`}
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            title="Choose a custom color theme"
          >
            <Palette size={18} />
          </button>
          
          {showThemeMenu && (
            <div className="theme-dropdown-menu">
              <div className="theme-dropdown-header">Select Theme</div>
              <div className="theme-dropdown-divider"></div>
              {THEMES.map((t) => {
                const isActive = theme === t.id;
                return (
                  <button
                    key={t.id}
                    className={`theme-dropdown-item ${isActive ? "active" : ""}`}
                    onClick={() => {
                      setTheme(t.id);
                      setShowThemeMenu(false);
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.primary }} />
                        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: t.secondary }} />
                      </div>
                      <span className="theme-name-text">{t.name}</span>
                      {isActive && <Check size={12} style={{ marginLeft: "auto", color: "var(--md-sys-color-primary)" }} />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {serverRunning && (
          <button
            className="m3-btn m3-btn-error"
            style={{ height: "34px", padding: "0 14px" }}
            onClick={onStopServer}
            disabled={isStoppingServer}
            title="Stop local model server"
          >
            {isStoppingServer ? <RefreshCw className="progress-spinner" size={14} /> : <Square size={14} />}
            <span>{isStoppingServer ? "Stopping" : "Stop Server"}</span>
          </button>
        )}

      </div>
    </div>
  );
}

export default memo(TopStatusBar);
