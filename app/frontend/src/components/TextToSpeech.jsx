import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Download,
  Gauge,
  LoaderCircle,
  Pause,
  Play,
  Settings2,
  Square,
  Trash2,
  User,
} from "lucide-react";
import {
  deleteTtsOutput,
  getTtsStatus,
  listTtsModels,
  speakTts,
  startTts,
  stopTts,
} from "../services/api";
import "../styles/voice.css";

const FALLBACK_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "Female" },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "Female" },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "Male" },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "Female" },
  { id: "bm_george", name: "George", language: "en-gb", gender: "Male" },
];

const MAX_CHARS = 5000;

function downloadUrl(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const clipId = (clip) => clip && (clip.filename || clip.metadata || clip.audioFile || clip.url);

function formatDuration(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return "";
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatSpeed(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `${Number(num.toFixed(2))}×`;
}

export default function TextToSpeech({
  showAlert,
  showConfirm,
  selectedOutput,
  onOutputsChanged,
  ttsSettings,
  setTtsSettings,
  // Optional: the saved clip history and delete handler from App.jsx. When they are not
  // passed, the screen lists the clips made in this session plus the sidebar selection.
  outputs,
  onDeleteOutput,
}) {
  const [status, setStatus] = useState({ ready: false, running: false, runtimeInstalled: false, settings: {}, voices: [] });
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [text, setText] = useState("");
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [sessionClips, setSessionClips] = useState([]);
  const [deletedIds, setDeletedIds] = useState(() => new Set());
  const [activeId, setActiveId] = useState(null);
  const [playingId, setPlayingId] = useState(null);
  const [openMenu, setOpenMenu] = useState(null); // "model" | "settings" | "voice" | "speed"
  const abortRef = useRef(null);
  const audioRef = useRef(null);
  const rowRefs = useRef(new Map());
  const headerMenusRef = useRef(null);
  const voiceMenuRef = useRef(null);
  const speedMenuRef = useRef(null);

  const installedModels = useMemo(() => models.filter((model) => model.installed), [models]);
  const voices = status.voices?.length ? status.voices : FALLBACK_VOICES;
  const selectedVoice = ttsSettings?.voice || "af_heart";
  const speed = ttsSettings?.speed || 1;
  const currentVoice = voices.find((voice) => voice.id === selectedVoice);

  const updateTtsSetting = (key, value) => {
    setTtsSettings((prev) => ({ ...prev, [key]: value }));
  };

  const refresh = useCallback(async () => {
    const [nextStatus, nextModels] = await Promise.all([
      getTtsStatus(),
      listTtsModels(),
    ]);
    setStatus(nextStatus);
    setModels(nextModels);
    setSelectedModel((current) => {
      const installed = nextModels.filter((model) => model.installed);
      if (current && installed.some((model) => model.filename === current || model.id === current)) return current;
      const active = nextStatus.settings?.model;
      if (active && installed.some((model) => model.filename === active)) return active;
      const preferred = ttsSettings?.model;
      if (preferred && installed.some((model) => model.filename === preferred)) return preferred;
      return installed.find((model) => model.recommended)?.filename || installed[0]?.filename || "";
    });
  }, [ttsSettings?.model]);

  useEffect(() => {
    refresh().catch((err) => showAlert?.({ title: "Couldn't read voice status", message: err.message || String(err), danger: true }));
    const interval = setInterval(() => {
      refresh().catch(() => {});
    }, 2500);
    return () => clearInterval(interval);
  }, [refresh, showAlert]);

  useEffect(() => {
    if (!selectedOutput) return;
    setActiveId(clipId(selectedOutput));
    setText(selectedOutput.text || "");
    if (selectedOutput.voice) updateTtsSetting("voice", selectedOutput.voice);
    if (selectedOutput.speed) updateTtsSetting("speed", selectedOutput.speed);
    if (selectedOutput.model) setSelectedModel(selectedOutput.model);
  }, [selectedOutput]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
    };
  }, []);

  // Close whichever menu is open on an outside click or Escape.
  useEffect(() => {
    if (!openMenu) return undefined;
    const refs = {
      model: headerMenusRef,
      settings: headerMenusRef,
      voice: voiceMenuRef,
      speed: speedMenuRef,
    };
    const handleClickOutside = (event) => {
      const ref = refs[openMenu];
      if (ref?.current && !ref.current.contains(event.target)) setOpenMenu(null);
    };
    const handleKey = (event) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  const toggleMenu = (name) => setOpenMenu((current) => (current === name ? null : name));

  // Clips shown on the page, newest first.
  const clips = useMemo(() => {
    const seen = new Set();
    const list = [];
    const add = (clip) => {
      const id = clipId(clip);
      if (!clip || !id || seen.has(id) || deletedIds.has(id)) return;
      seen.add(id);
      list.push(clip);
    };
    if (Array.isArray(outputs)) {
      outputs.forEach(add);
    } else {
      sessionClips.forEach(add);
      add(selectedOutput);
    }
    return list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [outputs, sessionClips, selectedOutput, deletedIds]);

  useEffect(() => {
    if (!activeId) return;
    rowRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId, clips.length]);

  const handleLoadModel = async (modelName = selectedModel) => {
    if (!modelName) return;
    setIsLoadingModel(true);
    try {
      await startTts(modelName, { voice: selectedVoice, speed });
      updateTtsSetting("model", modelName);
      await refresh();
    } catch (err) {
      showAlert?.({ title: "Couldn't load the voice model", message: err.message || String(err), danger: true });
    } finally {
      setIsLoadingModel(false);
    }
  };

  const handleStop = async () => {
    try {
      await stopTts();
      await refresh();
    } catch (err) {
      showAlert?.({ title: "Couldn't stop the voice runtime", message: err.message || String(err), danger: true });
    }
  };

  const handleRefresh = () => {
    refresh().catch((err) => showAlert?.({ title: "Couldn't read voice status", message: err.message || String(err), danger: true }));
  };

  const handleGenerate = async () => {
    if (isGenerating || !text.trim() || !selectedModel) return;
    setIsGenerating(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (!status.ready || status.settings?.model !== selectedModel) {
        setIsLoadingModel(true);
        try {
          await startTts(selectedModel, { voice: selectedVoice, speed });
          updateTtsSetting("model", selectedModel);
          await refresh();
        } finally {
          setIsLoadingModel(false);
        }
      }
      const generated = await speakTts(text, {
        model: selectedModel,
        voice: selectedVoice,
        speed,
        signal: controller.signal,
      });
      setSessionClips((prev) => [generated, ...prev]);
      setActiveId(clipId(generated));
      setText("");
      await refresh();
      await onOutputsChanged?.();
    } catch (err) {
      if (err.name !== "AbortError") {
        showAlert?.({ title: "Couldn't generate speech", message: err.message || String(err), danger: true });
      }
    } finally {
      abortRef.current = null;
      setIsGenerating(false);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setIsGenerating(false);
  };

  const togglePlay = (clip) => {
    const audio = audioRef.current;
    const id = clipId(clip);
    if (!audio || !clip?.url) return;
    if (playingId === id) {
      audio.pause();
      return;
    }
    audio.pause();
    audio.src = clip.url;
    audio.currentTime = 0;
    setActiveId(id);
    audio.play().then(() => setPlayingId(id)).catch((err) => {
      setPlayingId(null);
      if (err.name !== "AbortError") {
        showAlert?.({ title: "Couldn't play the clip", message: err.message || String(err), danger: true });
      }
    });
  };

  const handleDelete = async (clip, event) => {
    const id = clipId(clip);
    if (playingId === id) audioRef.current?.pause();
    if (onDeleteOutput) {
      await onDeleteOutput(clip, event);
      return;
    }
    const itemId = clip.filename || clip.metadata;
    if (!itemId) return;
    const preview = (clip.text || clip.displayName || "this clip").slice(0, 60);
    const ok = showConfirm
      ? await showConfirm({
        title: "Delete clip",
        message: `Delete "${preview}"? This can't be undone.`,
        confirmLabel: "Delete",
        danger: true,
      })
      : true;
    if (!ok) return;
    try {
      await deleteTtsOutput(itemId);
      setDeletedIds((prev) => new Set(prev).add(id));
      setSessionClips((prev) => prev.filter((item) => clipId(item) !== id));
      await onOutputsChanged?.();
    } catch (err) {
      showAlert?.({ title: "Couldn't delete the clip", message: err.message || String(err), danger: true });
    }
  };

  const isLoaded = status.ready && status.settings?.model === selectedModel;
  const selectedModelInfo = installedModels.find((model) => model.filename === selectedModel || model.id === selectedModel);
  const modelLabel = selectedModelInfo?.name || selectedModel || (installedModels.length ? "Choose a model" : "No voice model");
  const runtimeLabel = status.runtimeInstalled ? (status.ready ? "Ready" : "Installed") : "Runtime missing";
  const charCount = text.trim().length;
  const canGenerate = Boolean(text.trim()) && Boolean(selectedModel) && status.runtimeInstalled;

  let notice = "";
  if (installedModels.length === 0) notice = "Download a Kokoro model in Models, under TTS models, to start.";
  else if (!status.runtimeInstalled) notice = "The voice runtime isn't installed. Run the TTS setup script for this platform.";

  const composer = (
    <div className="chat-composer">
      <div className="chat-composer-inner">
        <textarea
          className="chat-composer-textarea voice-composer-textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canGenerate) handleGenerate();
            }
          }}
          placeholder="Type something to speak"
          aria-label="Text to speak"
          maxLength={MAX_CHARS}
          rows={1}
        />

        <div className="chat-composer-toolbar">
          <div className="chat-composer-toolbar-left">
            <div ref={voiceMenuRef} className="voice-anchor">
              <button
                type="button"
                className={`chat-composer-chip ${openMenu === "voice" ? "voice-chip-open" : ""}`}
                onClick={() => toggleMenu("voice")}
                aria-haspopup="menu"
                aria-expanded={openMenu === "voice"}
                title="Voice"
              >
                <User size={15} aria-hidden="true" />
                <span>{currentVoice?.name || selectedVoice}</span>
              </button>
              {openMenu === "voice" && (
                <div className="chat-model-menu up voice-menu-left" role="menu" aria-label="Voices">
                  <div className="chat-model-menu-label">Voices</div>
                  {voices.map((voice) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={voice.id === selectedVoice}
                      key={voice.id}
                      className={`chat-model-menu-item ${voice.id === selectedVoice ? "selected" : ""}`}
                      onClick={() => {
                        updateTtsSetting("voice", voice.id);
                        setOpenMenu(null);
                      }}
                    >
                      <span className="chat-model-menu-name">{voice.name}</span>
                      <span className="voice-menu-meta">
                        {[voice.gender, voice.language].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div ref={speedMenuRef} className="voice-anchor">
              <button
                type="button"
                className={`chat-composer-chip ${openMenu === "speed" ? "voice-chip-open" : ""}`}
                onClick={() => toggleMenu("speed")}
                aria-haspopup="dialog"
                aria-expanded={openMenu === "speed"}
                title="Speed"
              >
                <Gauge size={15} aria-hidden="true" />
                <span>{formatSpeed(speed)}</span>
              </button>
              {openMenu === "speed" && (
                <div className="popover voice-popover-up" role="dialog" aria-label="Speed">
                  <div className="field">
                    <div className="voice-speed-head">
                      <label className="field-label" htmlFor="voice-speed">Speed</label>
                      <span className="voice-speed-value">{formatSpeed(speed)}</span>
                    </div>
                    <input
                      id="voice-speed"
                      className="voice-speed-range"
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.05"
                      value={speed}
                      onChange={(event) => updateTtsSetting("speed", Math.max(0.5, Math.min(2, Number(event.target.value) || 1)))}
                    />
                    <div className="voice-speed-scale" aria-hidden="true">
                      <span>0.5×</span>
                      <span>2×</span>
                    </div>
                  </div>
                  {speed !== 1 && (
                    <button type="button" className="btn voice-speed-reset" onClick={() => updateTtsSetting("speed", 1)}>
                      Reset to 1×
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="chat-composer-toolbar-right">
            {isGenerating ? (
              <span className="voice-generating" role="status">
                <LoaderCircle size={14} className="voice-spin" aria-hidden="true" />
                {isLoadingModel ? "Loading model" : "Generating"}
              </span>
            ) : (
              <span className="voice-char-count" aria-live="polite">
                {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              </span>
            )}
            {isGenerating ? (
              <button
                type="button"
                className="chat-composer-stop-btn"
                onClick={handleCancel}
                aria-label="Cancel generation"
                title="Cancel generation"
              >
                <Square size={14} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="chat-composer-send-btn"
                onClick={handleGenerate}
                disabled={!canGenerate}
                aria-label="Generate speech"
                title="Generate speech"
              >
                <ArrowUp size={18} strokeWidth={2.25} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="page voice-page">
      <audio
        ref={audioRef}
        className="voice-audio"
        preload="none"
        onPause={() => setPlayingId(null)}
        onEnded={() => setPlayingId(null)}
      />

      <div className="page-scroll">
        <div className="page-column">
          <header className="page-header">
            <h2 className="page-title">Voice</h2>

            <div ref={headerMenusRef} className="voice-header-tools">
              <div className="chat-model-picker">
                <button
                  type="button"
                  className={`chat-model-trigger ${openMenu === "model" ? "active" : ""}`}
                  onClick={() => toggleMenu("model")}
                  disabled={isGenerating}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "model"}
                  title={selectedModel || "Choose a Kokoro model"}
                >
                  {isLoadingModel ? (
                    <LoaderCircle size={14} className="voice-spin" aria-hidden="true" />
                  ) : (
                    isLoaded && <span className="chat-model-dot" aria-hidden="true" />
                  )}
                  <span className="chat-model-trigger-label">{modelLabel}</span>
                  <ChevronDown size={15} aria-hidden="true" />
                </button>

                {openMenu === "model" && (
                  <div className="chat-model-menu" role="menu" aria-label="Voice models">
                    <div className="chat-model-menu-label">Voice models</div>
                    {installedModels.length === 0 && (
                      <div className="chat-model-menu-label voice-menu-empty">
                        No models yet. Download one in Models.
                      </div>
                    )}
                    {installedModels.map((model) => {
                      const active = status.ready && status.settings?.model === model.filename;
                      return (
                        <button
                          type="button"
                          role="menuitem"
                          key={model.id || model.filename}
                          className={`chat-model-menu-item ${model.filename === selectedModel ? "selected" : ""}`}
                          onClick={() => {
                            setOpenMenu(null);
                            setSelectedModel(model.filename);
                            if (!active) handleLoadModel(model.filename);
                          }}
                          disabled={isLoadingModel}
                          title={model.filename}
                        >
                          <span className="chat-model-menu-name">{model.name || model.filename}</span>
                          {active && <span className="chat-model-menu-badge">Loaded</span>}
                        </button>
                      );
                    })}
                    <div className="chat-model-menu-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      className="chat-model-menu-item"
                      onClick={() => {
                        setOpenMenu(null);
                        handleRefresh();
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                )}
              </div>

              <div className="voice-anchor">
                <button
                  type="button"
                  className={`icon-btn ${openMenu === "settings" ? "voice-icon-btn-active" : ""}`}
                  onClick={() => toggleMenu("settings")}
                  aria-haspopup="dialog"
                  aria-expanded={openMenu === "settings"}
                  aria-label="Runtime options"
                  title="Runtime options"
                >
                  <Settings2 size={17} aria-hidden="true" />
                </button>
                {openMenu === "settings" && (
                  <div className="popover voice-popover-down" role="dialog" aria-label="Runtime options">
                    <div className="voice-runtime-row">
                      <span className="field-label">Runtime</span>
                      <span className={`tag ${status.ready ? "tag-success" : ""}`}>{runtimeLabel}</span>
                    </div>
                    {status.error && <p className="voice-runtime-error">{status.error}</p>}
                    <p className="field-hint voice-runtime-hint">
                      Kokoro runs locally. Stopping the runtime frees its memory; it starts again when you generate.
                    </p>
                    <div className="voice-runtime-actions">
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => {
                          setOpenMenu(null);
                          handleStop();
                        }}
                        disabled={!status.ready}
                      >
                        <Square size={13} aria-hidden="true" />
                        Stop runtime
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          {notice && <p className="voice-notice" role="status">{notice}</p>}
          {status.error && !notice && <p className="voice-notice voice-notice-error" role="alert">{status.error}</p>}

          {clips.length === 0 ? (
            <div className="empty-state voice-empty">
              <div className="empty-state-title">Turn text into speech</div>
              <p>Type below, pick a voice and speed, then press Enter.</p>
            </div>
          ) : (
            <ul className="row-list voice-clip-list">
              {clips.map((clip) => {
                const id = clipId(clip);
                const isActive = id === activeId;
                const isPlaying = id === playingId;
                const meta = [
                  clip.voiceName || clip.voice,
                  clip.speed ? formatSpeed(clip.speed) : "",
                  formatDuration(clip.durationMs),
                ].filter(Boolean).join(" · ");
                const created = clip.createdAt ? new Date(clip.createdAt).toLocaleString() : "";
                return (
                  <li
                    key={id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(id, node);
                      else rowRefs.current.delete(id);
                    }}
                    className={`row-item voice-clip ${isActive ? "is-active" : ""}`}
                  >
                    <button
                      type="button"
                      className="voice-play-btn"
                      onClick={() => togglePlay(clip)}
                      disabled={!clip.url}
                      aria-label={isPlaying ? "Pause clip" : "Play clip"}
                      title={isPlaying ? "Pause" : "Play"}
                    >
                      {isPlaying ? (
                        <Pause size={15} fill="currentColor" aria-hidden="true" />
                      ) : (
                        <Play size={15} fill="currentColor" className="voice-play-icon" aria-hidden="true" />
                      )}
                    </button>

                    <button
                      type="button"
                      className="row-item-main voice-clip-main"
                      onClick={() => setActiveId(isActive ? null : id)}
                      aria-expanded={isActive}
                      title={created}
                    >
                      <span className={`row-item-title voice-clip-text ${isActive ? "" : "is-clamped"}`}>
                        {clip.text || clip.displayName || clip.audioFile || "Untitled clip"}
                      </span>
                      {(meta || (isActive && created)) && (
                        <span className="row-item-meta voice-clip-meta">
                          {meta}
                          {isActive && created && <>{meta ? " · " : ""}{created}</>}
                        </span>
                      )}
                    </button>

                    <div className="row-item-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => clip.url && downloadUrl(clip.url, clip.audioFile || "tts.wav")}
                        disabled={!clip.url}
                        aria-label="Download WAV"
                        title="Download WAV"
                      >
                        <Download size={16} aria-hidden="true" />
                      </button>
                      {(clip.filename || clip.metadata) && (
                        <button
                          type="button"
                          className="icon-btn danger"
                          onClick={(event) => handleDelete(clip, event)}
                          aria-label="Delete clip"
                          title="Delete clip"
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="page-dock">{composer}</div>
    </div>
  );
}
