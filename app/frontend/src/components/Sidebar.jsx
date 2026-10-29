import React, { memo, useMemo } from "react";
import { Image, Box, MessageSquare, Mic, Settings, Shield, Trash2, Volume2, SquarePen, PanelLeftClose, Cpu } from "lucide-react";

function formatGb(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return number.toFixed(number >= 10 ? 0 : 1);
}

function toTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Lets div-based rows respond to Enter/Space like real buttons (ignores keys from nested buttons)
function activateOnKey(e) {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.currentTarget.click();
  }
}

const RECENT_ICONS = { chat: MessageSquare, speech: Mic, tts: Volume2 };

function Sidebar({
  collapsed = false,
  onToggleSidebar,
  activeTab,
  setActiveTab,
  specs,
  telemetry,
  onNewChat,
  conversations = [],
  activeConversationId,
  setActiveConversationId,
  onDeleteConversation,
  speechTranscriptions = [],
  selectedSpeechTranscript,
  setSelectedSpeechTranscript,
  onDeleteSpeechTranscription,
  ttsOutputs = [],
  selectedTtsOutput,
  setSelectedTtsOutput,
  onDeleteTtsOutput
}) {
  // One list for chats, transcriptions and voice clips, newest first
  const recents = useMemo(() => {
    const speechId = (item) => item && (item.filename || item.metadata || item.textFile);
    const ttsId = (item) => item && (item.filename || item.metadata || item.audioFile);

    const chats = conversations.map((conv) => ({
      key: `chat:${conv.id}`,
      type: "chat",
      title: conv.title || "Chat",
      time: toTime(conv.timestamp),
      isActive: activeTab === "chat" && activeConversationId === conv.id,
      open: () => {
        setActiveConversationId(conv.id);
        setActiveTab("chat");
      },
      remove: (e) => onDeleteConversation(conv.id, e),
      deleteLabel: "Delete chat",
    }));

    const speech = speechTranscriptions.map((item) => ({
      key: `speech:${speechId(item)}`,
      type: "speech",
      title: item.displayName || item.sourceFilename || item.textFile || item.filename || "Transcript",
      time: toTime(item.modifiedAt || item.createdAt),
      isActive: activeTab === "speech" && speechId(selectedSpeechTranscript) === speechId(item),
      open: () => {
        setSelectedSpeechTranscript(item);
        setActiveTab("speech");
      },
      remove: (e) => onDeleteSpeechTranscription?.(item, e),
      deleteLabel: "Delete transcription",
    }));

    const voice = ttsOutputs.map((item) => ({
      key: `tts:${ttsId(item)}`,
      type: "tts",
      title: item.displayName || item.text || item.audioFile || item.filename || "Voice clip",
      time: toTime(item.modifiedAt || item.createdAt),
      isActive: activeTab === "tts" && ttsId(selectedTtsOutput) === ttsId(item),
      open: () => {
        setSelectedTtsOutput(item);
        setActiveTab("tts");
      },
      remove: (e) => onDeleteTtsOutput?.(item, e),
      deleteLabel: "Delete voice clip",
    }));

    return [...chats, ...speech, ...voice].sort((a, b) => b.time - a.time);
  }, [
    conversations, speechTranscriptions, ttsOutputs, activeTab, activeConversationId,
    selectedSpeechTranscript, selectedTtsOutput, setActiveTab, setActiveConversationId,
    setSelectedSpeechTranscript, setSelectedTtsOutput, onDeleteConversation,
    onDeleteSpeechTranscription, onDeleteTtsOutput
  ]);

  const navItems = [
    { tab: "generator", label: "Images", Icon: Image },
    { tab: "speech", label: "Transcribe", Icon: Mic },
    { tab: "tts", label: "Voice", Icon: Volume2 },
    { tab: "models", label: "Models", Icon: Box },
  ];

  const isNewChatActive = activeTab === "chat" && !activeConversationId;
  const deviceName = specs.gpu_name && !specs.gpu_name.startsWith("Loading") ? specs.gpu_name : specs.cpu_name;
  const cpuUsage = Number(telemetry?.cpu_usage);

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <Shield className="sidebar-logo-icon" aria-hidden="true" />
          <span className="sidebar-logo-text">Local AI Studio</span>
        </div>
        <button type="button" className="sidebar-icon-btn" onClick={onToggleSidebar} aria-label="Close sidebar" title="Close sidebar">
          <PanelLeftClose size={18} />
        </button>
      </div>

      <nav className="nav-list" aria-label="Main">
        <div
          className={`nav-item ${isNewChatActive ? "active" : ""}`}
          role="button"
          tabIndex={0}
          aria-current={isNewChatActive ? "page" : undefined}
          onClick={onNewChat}
          onKeyDown={activateOnKey}
        >
          <SquarePen size={18} aria-hidden="true" />
          <span>New chat</span>
        </div>
        {navItems.map(({ tab, label, Icon }) => (
          <div
            key={tab}
            className={`nav-item ${activeTab === tab ? "active" : ""}`}
            role="button"
            tabIndex={0}
            aria-current={activeTab === tab ? "page" : undefined}
            onClick={() => setActiveTab(tab)}
            onKeyDown={activateOnKey}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-recents">
        <div className="sidebar-section-label" id="sidebar-recents-label">Recents</div>
        {recents.length === 0 ? (
          <div className="sidebar-recents-empty">Your chats, transcriptions and voice clips show up here.</div>
        ) : (
          <ul className="sidebar-recents-list" aria-labelledby="sidebar-recents-label">
            {recents.map((item) => {
              const Icon = RECENT_ICONS[item.type];
              return (
                <li key={item.key}>
                  <div
                    className={`sidebar-history-item ${item.isActive ? "active" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-current={item.isActive ? "page" : undefined}
                    onClick={item.open}
                    onKeyDown={activateOnKey}
                    title={item.title}
                  >
                    <Icon size={14} className="sidebar-history-icon" aria-hidden="true" />
                    <span className="sidebar-history-title">{item.title}</span>
                    <button
                      type="button"
                      className="sidebar-history-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        item.remove(e);
                      }}
                      aria-label={`${item.deleteLabel}: ${item.title}`}
                      title={item.deleteLabel}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="sidebar-device">
        <div className="sidebar-device-icon" aria-hidden="true">
          <Cpu size={16} />
        </div>
        <div className="sidebar-device-info" title={`${specs.cpu_name} · ${specs.gpu_name} · ${specs.os_name}`}>
          <div className="sidebar-device-name">{deviceName}</div>
          <div className="sidebar-device-stats">
            Offline · RAM {formatGb(telemetry?.ram_used_gb)}/{formatGb(telemetry?.ram_total_gb || specs.ram_total_gb)} GB
            {Number.isFinite(cpuUsage) ? ` · CPU ${Math.round(cpuUsage)}%` : ""}
          </div>
        </div>
        <button
          type="button"
          className={`sidebar-icon-btn ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
          aria-label="Settings"
          aria-current={activeTab === "settings" ? "page" : undefined}
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}

export default memo(Sidebar);
