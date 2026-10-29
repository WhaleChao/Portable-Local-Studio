import React, { memo, useState, useRef, useCallback, useEffect } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Dices,
  Download,
  ImagePlus,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Square,
  Trash2,
  AlertTriangle,
  X,
} from "lucide-react";
import {
  generateImage,
  startServer,
  stopServer,
  waitForServerReady,
  getBackendStatus,
  getGenerationProgress,
  saveGeneratedOutput,
  deleteGeneratedOutputs,
  getLlmStatus,
  listLlmModels,
  startLlm,
  chatWithLlm,
  stopLlm,
  listLocalModels,
  normalizeModel
} from "../services/api";
import "../styles/images.css";

// Common sizes: the standard set suits SD 1.5 models, the large set suits SDXL / Flux.
const SIZE_GROUPS = [
  {
    label: "Standard",
    sizes: [
      { ratio: "1:1", width: 512, height: 512 },
      { ratio: "4:3", width: 640, height: 480 },
      { ratio: "16:9", width: 768, height: 432 },
      { ratio: "9:16", width: 432, height: 768 },
    ],
  },
  {
    label: "Large",
    sizes: [
      { ratio: "1:1", width: 1024, height: 1024 },
      { ratio: "4:3", width: 1152, height: 864 },
      { ratio: "16:9", width: 1216, height: 684 },
      { ratio: "9:16", width: 684, height: 1216 },
    ],
  },
];

const SAMPLERS = ["euler_a", "euler", "heun", "dpm2", "dpm++2s_a", "dpm++2m", "dpm++2mv2", "ipndm", "ipndm_v", "lcm"];

const modelDisplayName = (model) =>
  model ? model.split(/[\\/]/).pop().replace(/\.(safetensors|gguf|ckpt|bin)$/i, "") : "";

const sizeLabel = (width, height) => {
  for (const group of SIZE_GROUPS) {
    const match = group.sizes.find((s) => s.width === width && s.height === height);
    if (match) return `${match.ratio} · ${width}×${height}`;
  }
  return `${width}×${height}`;
};

const GalleryItem = memo(({ img, idx, isSelected, selectMode, onActivate }) => {
  const handleClick = (e) => {
    onActivate(idx, e);
  };
  const label = img.prompt ? `Image: ${img.prompt}` : "Generated image";
  return (
    <button
      type="button"
      className={`images-tile ${isSelected ? "selected" : ""}`}
      onClick={handleClick}
      aria-label={label}
      aria-pressed={selectMode ? isSelected : undefined}
      title={`Prompt: ${img.prompt}\nSeed: ${img.seed}${img.duration_sec ? `\nTime: ${img.duration_sec.toFixed(1)}s` : ""}`}
    >
      <img src={img.url} className="images-tile-img" alt="" loading="lazy" decoding="async" />
      {(isSelected || selectMode) && (
        <span className={`images-tile-check ${isSelected ? "on" : ""}`} aria-hidden="true">
          {isSelected && <Check size={14} />}
        </span>
      )}
    </button>
  );
});

function Generator({
  prompt,
  setPrompt,
  negativePrompt,
  setNegativePrompt,
  constraints,
  setConstraints,
  activeModel,
  generatedImages,
  setGeneratedImages,
  isGenerating,
  setIsGenerating,
  generationProgress,
  setGenerationProgress,
  setActiveTab,
  setActiveModel,
  showAlert = async ({ message }) => window.alert(message),
  showConfirm = async ({ message }) => window.confirm(message),
  specs,
  textSettings,
}) {
  const [outputImage, setOutputImage] = useState(null);
  const [outputSeed, setOutputSeed] = useState(null);
  const [genDuration, setGenDuration] = useState(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [estimatedLeftTime, setEstimatedLeftTime] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  const [generationSpeed, setGenerationSpeed] = useState("");
  const [isCpuFallback, setIsCpuFallback] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRestartingBackend, setIsRestartingBackend] = useState(false);
  const [restartLoadProgress, setRestartLoadProgress] = useState(null);
  // Image models listed in the composer's model picker (null while loading)
  const [imageModels, setImageModels] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [selectedGalleryIndexes, setSelectedGalleryIndexes] = useState([]);
  const [baseImage, setBaseImage] = useState(null);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const timerRef = useRef(null);
  const abortControllerRef = useRef(null);
  const hasRealGenerationStepRef = useRef(false);

  const handleEnhancePrompt = async () => {
    if (!prompt.trim() || isEnhancing || isGenerating) return;
    setIsEnhancing(true);
    try {
      const status = await getLlmStatus();
      let targetModel = status.settings?.model;
      
      if (!status.ready) {
        const models = await listLlmModels();
        if (models.length === 0) {
          showAlert({
            title: "No Text Models",
            message: "You haven't downloaded any text models yet. Please go to the 'Model Manager' or 'Text Chat' tab to download a GGUF model first.",
            danger: true
          });
          setIsEnhancing(false);
          return;
        }
        
        const savedLlm = localStorage.getItem("selectedLlmModel") || models[0]?.filename;
        targetModel = models.some(m => m.filename === savedLlm) ? savedLlm : models[0]?.filename;
        
        const confirm = await showConfirm({
          title: "Load Text Model?",
          message: `Enhancing your prompt requires loading the local text model "${targetModel}". This will temporarily unload the image model from memory. Do you want to proceed?`,
          confirmLabel: "Load & Enhance",
          cancelLabel: "Cancel"
        });
        
        if (!confirm) {
          setIsEnhancing(false);
          return;
        }
        
        const cores = textSettings?.threads || specs?.cpu_cores_physical || 4;
        const context = textSettings?.contextSize || 2048;
        await startLlm(targetModel, {
          threads: cores,
          contextSize: context,
          gpuLayers: -1,
          preferredBackend: textSettings?.preferredBackend
        });
      }
      
      const systemPrompt = "You are a helpful assistant. Rewrite the user's image prompt to be more descriptive and detailed for image generation. Keep it under 80 words. Output ONLY the rewritten prompt, no explanation or introductory text.";
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Please expand this prompt: "${prompt}"` }
      ];
      
      const temp = textSettings?.temperature || 0.7;
      const response = await chatWithLlm(messages, { temperature: temp, maxTokens: 128 });
      let cleanResponse = response.content.trim();
      if (cleanResponse.startsWith('"') && cleanResponse.endsWith('"')) {
        cleanResponse = cleanResponse.slice(1, -1);
      }
      cleanResponse = cleanResponse.replace(/^Here is the expanded prompt:?\s*/i, "");
      cleanResponse = cleanResponse.replace(/^Enhanced prompt:?\s*/i, "");
      
      setPrompt(cleanResponse);
    } catch (err) {
      showAlert({
        title: "Prompt Enhancement Failed",
        message: err.message || String(err),
        danger: true
      });
    } finally {
      setIsEnhancing(false);
    }
  };

  React.useEffect(() => {
    if (constraints.backendType === "apple-npu" || constraints.backendType === "openvino-npu") {
      setBaseImage(null);
    }
  }, [constraints.backendType]);

  const handleBaseImageSelect = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorMsg("That file is not an image. Choose a PNG, JPG, or WEBP file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBaseImage(reader.result);
    reader.onerror = () => setErrorMsg("Could not read the selected image file.");
    reader.readAsDataURL(file);
  };

  const handleClearBaseImage = () => setBaseImage(null);

  // Trigger main image generation process
  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setErrorMsg(null);
    setIsRestartingBackend(true);
    setRestartLoadProgress(null);

    let needsRestart = false;
    try {
      const status = await getBackendStatus();
      if (status && status.settings) {
        const settings = status.settings;
        const currentModelName = settings.model ? settings.model.split(/[\\/]/).pop() : null;
        const targetModelName = activeModel ? activeModel.split(/[\\/]/).pop() : null;
        const requestedBackend = constraints.backendType || (constraints.useGpu === false ? "cpu" : "auto");
        const currentBackend = settings.backendType || (settings.useGpu === false ? "cpu" : "auto");
        const shouldCompareModel = requestedBackend !== "openvino-npu";
        const isCoreMLBackend = requestedBackend === "apple-npu";

        if ((shouldCompareModel && currentModelName !== targetModelName) ||
            (!isCoreMLBackend && parseInt(settings.steps) !== parseInt(constraints.steps)) ||
            (!isCoreMLBackend && Math.abs(parseFloat(settings.cfgScale) - parseFloat(constraints.cfgScale)) > 0.05) ||
            (!isCoreMLBackend && settings.sampler !== constraints.sampler) ||
            (!isCoreMLBackend && parseInt(settings.threads) !== parseInt(constraints.threads)) ||
            Boolean(settings.useGpu) !== (constraints.useGpu !== false) ||
            parseInt(settings.width || 512) !== parseInt(constraints.width || 512) ||
            parseInt(settings.height || 512) !== parseInt(constraints.height || 512) ||
            currentBackend !== requestedBackend) {
          needsRestart = true;
        }
      } else {
        needsRestart = true;
      }
    } catch (e) {
      needsRestart = true;
    }

    if (needsRestart) {
      try {
        console.log("Settings out of sync, restarting backend...");
        await startServer(activeModel, constraints);
                let isReady = false;
        let crashError = null;
        const maxStartupPolls = (constraints.backendType === "openvino-npu" || constraints.backendType === "apple-npu") ? 1200 : 240;
        for (let i = 0; i < maxStartupPolls; i++) {
          const status = await getBackendStatus();
          if (status.loading) {
            setRestartLoadProgress({
              progress: status.loading.progress || 0,
              phase: status.loading.phase || "Loading model...",
              speed: status.loading.speed || "",
              current: status.loading.current || 0,
              total: status.loading.total || 0,
              backendMode: status.loading.backendMode || status.settings?.backendMode || "",
              device: status.loading.device || status.settings?.backendDevice || "",
            });
          }
          if (status.ready) {
            isReady = true;
            break;
          }
          if (status.error) {
            crashError = status.error;
            break;
          }
          if (!status.running && !status.loading?.active && i > 3) {
            crashError = "The backend process terminated immediately on startup.";
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!isReady) {
          throw new Error(crashError || "Backend server failed to start after applying configuration changes.");
        }
      } catch (err) {
        console.error("Failed to restart backend:", err);
        setErrorMsg(err.message || "Failed to sync settings with backend.");
        setIsRestartingBackend(false);
        return;
      }
    }
    setIsRestartingBackend(false);
    setRestartLoadProgress(null);

    if (timerRef.current) clearInterval(timerRef.current);
    setIsGenerating(true);
    setGenerationProgress(0);
    setElapsedTime(0);
    setCurrentStep(0);
    setGenerationSpeed("");
    hasRealGenerationStepRef.current = false;
    setIsCpuFallback(false);
    setIsDecoding(false);
    setGenDuration(null);
    setOutputImage(null);

    // Calculate dynamic step estimation times
    // CPU takes ~35s per step at 512px, ~140s at 1024px. GPU is ~0.04x of CPU time.
    const baseGpuStepTime = (constraints.width >= 1024 ? 140 : 35) * 0.04;
    const baseCpuStepTime = (constraints.width >= 1024 ? 140 : 35);
    
    const gpuSelected = (constraints.backendType || (constraints.useGpu === false ? "cpu" : "auto")) !== "cpu";
    let activeStepTime = gpuSelected ? baseGpuStepTime : baseCpuStepTime;
    let cpuFallbackDetected = false;
    let fallbackTime = 0;
    let fallbackProgress = 0;
    let elapsedSeconds = 0;

    setEstimatedLeftTime(Math.round(constraints.steps * activeStepTime));

    timerRef.current = setInterval(async () => {
      elapsedSeconds++;
      setElapsedTime(elapsedSeconds);

      try {
        const progress = await getGenerationProgress();
        if (progress && progress.active) {
          const decoding = progress.decoding || false;
          setIsDecoding(decoding);

          const step = decoding ? (progress.steps || constraints.steps || 20) : (progress.step || 0);
          const steps = progress.steps || constraints.steps || 20;
          const speed = decoding ? "" : (progress.speed || "");
          const numericSpeed = parseFloat(speed);
          const backendMode = String(progress.backendMode || "").toLowerCase();
          const backendDevice = String(progress.backendDevice || "").toLowerCase();
          const isConfirmedGpuBackend = (
            backendMode.includes("gpu") ||
            backendMode.includes("vulkan") ||
            backendMode.includes("cuda") ||
            backendMode.includes("rocm") ||
            backendMode.includes("metal") ||
            backendDevice.includes("vulkan") ||
            backendDevice.includes("cuda") ||
            backendDevice.includes("rocm")
          );

          if (decoding || progress.steps > 0) {
            hasRealGenerationStepRef.current = true;
            setCurrentStep(step);
          }
          if (!decoding) {
            setGenerationSpeed(speed);
          } else {
            setGenerationSpeed("decoding");
          }

          // Calculate progress percentage
          let progressPercent = 0;
          if (decoding) {
            progressPercent = 99;
          } else if (steps > 0) {
            progressPercent = Math.round((step / steps) * 100);
          }
          progressPercent = Math.min(99, progressPercent);
          if (decoding || progress.steps > 0) {
            setGenerationProgress(progressPercent);
          } else {
            setGenerationProgress((prev) => Math.max(prev, progressPercent));
          }

          // Calculate remaining time
          let remaining = 0;
          if (decoding) {
            remaining = 3;
          } else {
            if (!isNaN(numericSpeed) && numericSpeed > 0) {
              const remainingSteps = Math.max(0, steps - step);
              if (speed.includes("it/s")) {
                remaining = remainingSteps / numericSpeed;
              } else if (speed.includes("s/it")) {
                remaining = remainingSteps * numericSpeed;
              }
            } else {
              const activeStepTime = gpuSelected ? baseGpuStepTime : baseCpuStepTime;
              remaining = Math.max(0, (steps - step) * activeStepTime);
            }
          }

          // Detect CPU fallback / slow generation if GPU was requested but it runs slow
          if (gpuSelected && !cpuFallbackDetected && !isConfirmedGpuBackend) {
            const isSlowItS = speed.includes("it/s") && numericSpeed < 0.2;
            const isSlowSIt = speed.includes("s/it") && numericSpeed > 5.0;
            if (isSlowItS || isSlowSIt) {
              cpuFallbackDetected = true;
              setIsCpuFallback(true);
            }
          }

          setEstimatedLeftTime(Math.round(remaining));
        } else {
          // Creep up slowly while loading the model/preparing
          setGenerationProgress((prev) => Math.min(15, prev + 1));
          setEstimatedLeftTime((prev) => Math.max(1, prev - 1));
        }
      } catch (e) {
        console.warn("Failed to get generation progress, running simulation fallback:", e);

        // Fallback simulation logic
        if (gpuSelected && !cpuFallbackDetected && elapsedSeconds > constraints.steps * baseGpuStepTime * 1.3) {
          cpuFallbackDetected = true;
          setIsCpuFallback(true);
          activeStepTime = baseCpuStepTime;
          fallbackTime = elapsedSeconds;
          fallbackProgress = Math.min(95, Math.round((elapsedSeconds / (constraints.steps * baseGpuStepTime)) * 100));
        }

        let step = Math.min(constraints.steps - 1, Math.floor(elapsedSeconds / activeStepTime));
        let expectedTotal = constraints.steps * activeStepTime;
        if (elapsedSeconds >= expectedTotal) {
          const computedStepTime = Math.ceil(elapsedSeconds / Math.max(0.5, step));
          activeStepTime = Math.max(activeStepTime + 15, computedStepTime + 15);
          expectedTotal = constraints.steps * activeStepTime;
          step = Math.min(constraints.steps - 1, Math.floor(elapsedSeconds / activeStepTime));
        }
        const remaining = Math.max(1, expectedTotal - elapsedSeconds);
        setEstimatedLeftTime(Math.round(remaining));

        let progressPercent = 0;
        if (cpuFallbackDetected) {
          const remainingProgress = 99 - fallbackProgress;
          const remainingTime = expectedTotal - fallbackTime;
          if (remainingTime > 0) {
            const ratio = Math.min(1.0, (elapsedSeconds - fallbackTime) / remainingTime);
            if (ratio < 0.85) {
              progressPercent = Math.round(fallbackProgress + ratio * remainingProgress);
            } else {
              const x = (elapsedSeconds - (fallbackTime + remainingTime * 0.85)) / (activeStepTime * 2);
              const decay = 1 - Math.exp(-x);
              progressPercent = Math.min(99, Math.round(fallbackProgress + 0.85 * remainingProgress + (0.14 * remainingProgress) * decay));
            }
          } else {
            progressPercent = 99;
          }
        } else {
          if (elapsedSeconds < expectedTotal * 0.85) {
            progressPercent = Math.round((elapsedSeconds / expectedTotal) * 100);
          } else {
            const x = (elapsedSeconds - expectedTotal * 0.85) / (activeStepTime * 2);
            const decay = 1 - Math.exp(-x);
            progressPercent = Math.min(99, Math.round(85 + 14 * decay));
          }
        }
        if (!hasRealGenerationStepRef.current) {
          setGenerationProgress((p) => Math.max(p, progressPercent));
        }
      }
    }, 1000);

    try {
      abortControllerRef.current = new AbortController();
      const result = await generateImage(
        prompt,
        negativePrompt,
        constraints,
        activeModel,
        baseImage,
        (prog) => setGenerationProgress((prev) => Math.max(prev, prog)),
        abortControllerRef.current.signal
      );

      if (timerRef.current) clearInterval(timerRef.current);
      setGenerationProgress(100);
      setCurrentStep(constraints.steps);
      setEstimatedLeftTime(0);
      setGenerationSpeed("");

      const metadata = {
        prompt: prompt,
        negativePrompt: negativePrompt,
        seed: result.seed,
        steps: constraints.steps,
        cfgScale: constraints.cfgScale,
        width: constraints.width,
        height: constraints.height,
        sampler: constraints.sampler,
        model: activeModel,
        mode: baseImage ? "img2img" : "txt2img",
        denoisingStrength: baseImage ? constraints.denoisingStrength : null,
        duration_sec: result.duration_sec,
        timestamp: new Date().toLocaleTimeString(),
      };
      let savedOutput = null;
      let savedUrl = null;
      try {
        savedOutput = await saveGeneratedOutput(result.image, metadata);
        savedUrl = savedOutput.url;
        if (!savedUrl) {
          throw new Error("The local server saved the image but did not return a file URL.");
        }
      } catch (saveErr) {
        console.error("Generated image could not be saved:", saveErr);
        throw new Error(`Image generated but could not be saved to USB: ${saveErr.message || saveErr}`);
      }

      setOutputImage(savedUrl);
      setOutputSeed(result.seed);
      setGenDuration(result.duration_sec);

      const historyItem = {
        ...metadata,
        ...(savedOutput || {}),
        url: savedUrl,
      };

      setGeneratedImages((prev) => [historyItem, ...prev]);
    } catch (e) {
      if (e.name === "AbortError") {
        console.log("Generation request was aborted by the user");
      } else {
        console.error("Generation failed:", e);
        setErrorMsg(e.message || "Generation failed. Try again.");
      }
      if (timerRef.current) clearInterval(timerRef.current);
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  // Stop/Cancel Generation Handler
  const handleCancelGeneration = async () => {
    if (await showConfirm({
      title: "Stop Generation?",
      message: "The current image generation will be cancelled and the local model server may restart.",
      confirmLabel: "Stop",
      danger: true,
    })) {
      if (timerRef.current) clearInterval(timerRef.current);
      
      // Set cancelling state first to keep the progress overlay active in cancelling mode
      setIsCancelling(true);
      
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      
      try {
        console.log("Cancelling: Stopping server to kill generation threads...");
        await stopServer();
        setCurrentStep(0);
        setGenerationSpeed("");
        setIsDecoding(false);
        hasRealGenerationStepRef.current = false;

        if (activeModel) {
          console.log("Cancelling: Restarting server for future generations...");
          await startServer(activeModel, constraints);
          const ready = await waitForServerReady();
          if (!ready) {
            console.warn("Server failed to restart properly.");
          }
        }
      } catch (err) {
        console.error("Failed to restart server on cancellation:", err);
      } finally {
        setIsCancelling(false);
        setIsGenerating(false);
        setGenerationProgress(0);
        setEstimatedLeftTime(0);
      }
    }
  };

  // ---- Page UI state (layout only; generation logic lives above) ----
  const [selectMode, setSelectMode] = useState(false);
  const [viewerUrl, setViewerUrl] = useState(null);
  const [openMenu, setOpenMenu] = useState(null); // "size" | "steps" | "seed" | "more" | "model"
  const [backendReady, setBackendReady] = useState(false);
  const composerRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const viewerRef = useRef(null);
  const viewerCloseRef = useRef(null);
  const viewerReturnFocusRef = useRef(null);

  const isBusy = isGenerating || isCancelling || isRestartingBackend;
  const isNpuBackend = constraints.backendType === "apple-npu" || constraints.backendType === "openvino-npu";
  const isOpenVinoNpu = constraints.backendType === "openvino-npu";
  const maxSteps = isOpenVinoNpu ? 8 : 60;

  // Is the image backend running with the chosen model? Drives the green dot in the picker.
  useEffect(() => {
    let cancelled = false;
    if (!activeModel) {
      setBackendReady(false);
      return undefined;
    }
    getBackendStatus()
      .then((status) => {
        if (cancelled) return;
        const loadedName = status?.settings?.model ? status.settings.model.split(/[\\/]/).pop() : null;
        const targetName = activeModel.split(/[\\/]/).pop();
        setBackendReady(Boolean(status?.ready) && (loadedName === targetName || constraints.backendType === "openvino-npu"));
      })
      .catch(() => {
        if (!cancelled) setBackendReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeModel, isGenerating, isRestartingBackend, isCancelling, constraints.backendType]);

  // Close composer menus on outside click
  useEffect(() => {
    if (!openMenu) return undefined;
    const handleClickOutside = (event) => {
      if (composerRef.current && !composerRef.current.contains(event.target)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMenu]);

  const toggleMenu = (name) => setOpenMenu((current) => (current === name ? null : name));

  useEffect(() => {
    if (openMenu !== "model") return;
    let cancelled = false;
    setImageModels(null);
    listLocalModels()
      .then((list) => {
        if (!cancelled) setImageModels(list.map(normalizeModel).filter((model) => model.filename && !model.isProjector));
      })
      .catch(() => {
        if (!cancelled) setImageModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [openMenu]);

  // The backend refuses to start an image model while a chat model holds the GPU;
  // offer to free it and retry instead of sending the user to Models
  const textModelBlocking = Boolean(errorMsg && /already loaded as a text model/i.test(errorMsg));

  const handleUnloadTextAndGenerate = async () => {
    setErrorMsg(null);
    try {
      await stopLlm();
    } catch (err) {
      setErrorMsg(`Couldn't unload the text model: ${err.message || err}`);
      return;
    }
    handleGenerate();
  };

  // Regular weights are picked here and started on the next generate with the current
  // constraints (the same thing Models does for them). CoreML / OpenVINO model formats
  // need load-time overrides that only Models applies, so those open Models instead.
  const handlePickModel = (model) => {
    setOpenMenu(null);
    const needsModelsScreen = model.format === "CoreML" || ["apple-npu", "openvino-npu"].includes(model.backendType);
    if (needsModelsScreen || !setActiveModel) {
      setActiveTab?.("models");
      return;
    }
    setActiveModel(model.filename);
  };

  const updateConstraint = (key, value) => {
    setConstraints((prev) => ({
      ...prev,
      [key]: value,
      ...(key === "steps"
        ? isOpenVinoNpu
          ? { npuSteps: value }
          : { standardSteps: value }
        : {}),
    }));
  };

  const handleStepsChange = (raw) => {
    const value = parseInt(raw, 10);
    if (Number.isNaN(value)) return;
    updateConstraint("steps", Math.max(1, Math.min(maxSteps, value)));
  };

  const handleCfgChange = (raw) => {
    const value = parseFloat(raw);
    if (Number.isNaN(value)) return;
    updateConstraint("cfgScale", Math.max(1, Math.min(30, value)));
  };

  // Copy an image to the clipboard
  const copyImageUrl = async (url) => {
    if (!url) return;
    try {
      if (url.startsWith("data:image")) {
        // base64 conversion for clipboard
        const response = await fetch(url);
        const blob = await response.blob();
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob })
        ]);
      } else {
        // Draw on a canvas, then copy as PNG
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = url;
        img.onload = async () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(async (blob) => {
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type]: blob })
            ]);
          }, "image/png");
        };
      }
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error("Failed to copy image:", err);
    }
  };

  const downloadImageUrl = (url, filename = `diffusion-${Date.now()}.png`) => {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Reuse prompt settings from history
  const loadHistoryItem = useCallback((item) => {
    setPrompt(item.prompt);
    setNegativePrompt(item.negativePrompt);
    setConstraints((prev) => ({
      ...prev,
      steps: item.steps,
      cfgScale: item.cfgScale,
      width: item.width,
      height: item.height,
      sampler: item.sampler,
      seed: item.seed,
    }));
    setOutputImage(item.url);
    setOutputSeed(item.seed);
    setGenDuration(item.duration_sec ?? item.durationSec ?? null);
  }, [setPrompt, setNegativePrompt, setConstraints]);

  // ---- Viewer ----
  const viewerIndex = viewerUrl ? generatedImages.findIndex((img) => img.url === viewerUrl) : -1;
  const viewerItem = viewerIndex >= 0 ? generatedImages[viewerIndex] : null;

  const openViewer = useCallback((url, returnFocusEl) => {
    viewerReturnFocusRef.current = returnFocusEl || document.activeElement;
    setViewerUrl(url);
  }, []);

  const closeViewer = useCallback(() => {
    setViewerUrl(null);
    const el = viewerReturnFocusRef.current;
    viewerReturnFocusRef.current = null;
    if (el && typeof el.focus === "function" && document.contains(el)) {
      setTimeout(() => el.focus(), 0);
    }
  }, []);

  useEffect(() => {
    if (viewerUrl && viewerIndex === -1) setViewerUrl(null);
  }, [viewerUrl, viewerIndex]);

  const viewerOpen = Boolean(viewerItem);
  useEffect(() => {
    if (viewerOpen) viewerCloseRef.current?.focus();
  }, [viewerOpen]);

  const showViewerAt = (index) => {
    const item = generatedImages[index];
    if (item) setViewerUrl(item.url);
  };

  const handleViewerKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeViewer();
      return;
    }
    if (event.key === "ArrowLeft" && event.target.tagName !== "INPUT") {
      showViewerAt(viewerIndex - 1);
      return;
    }
    if (event.key === "ArrowRight" && event.target.tagName !== "INPUT") {
      showViewerAt(viewerIndex + 1);
      return;
    }
    if (event.key === "Tab" && viewerRef.current) {
      const focusables = Array.from(viewerRef.current.querySelectorAll("button:not(:disabled)"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const reuseFromViewer = (item) => {
    loadHistoryItem(item);
    setViewerUrl(null);
    viewerReturnFocusRef.current = null;
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const applyAsBaseImage = async (item) => {
    if (!item?.url) return;
    try {
      const response = await fetch(item.url);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read the image."));
        reader.readAsDataURL(blob);
      });
      setBaseImage(dataUrl);
      setViewerUrl(null);
      viewerReturnFocusRef.current = null;
      setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (err) {
      console.error("Failed to use image as base:", err);
      setErrorMsg("Could not use that image as the base image. Try adding it with the + button.");
    }
  };

  // ---- Gallery selection ----
  const handleTileActivate = useCallback((idx, event) => {
    const multi = event.ctrlKey || event.metaKey || event.shiftKey;
    if (multi || selectMode) {
      setSelectedGalleryIndexes((prev) =>
        prev.includes(idx) ? prev.filter((item) => item !== idx) : [...prev, idx]
      );
      return;
    }
    const item = generatedImages[idx];
    if (item) openViewer(item.url, event.currentTarget);
  }, [generatedImages, selectMode, openViewer]);

  const selectedGalleryItems = selectedGalleryIndexes
    .map((idx) => generatedImages[idx])
    .filter(Boolean);

  const clearGallerySelection = () => {
    setSelectedGalleryIndexes([]);
  };

  const toggleSelectMode = () => {
    setSelectMode((value) => {
      if (value) setSelectedGalleryIndexes([]);
      return !value;
    });
  };

  const useSelectedGalleryItem = () => {
    if (selectedGalleryItems[0]) {
      loadHistoryItem(selectedGalleryItems[0]);
    }
  };

  const downloadSelectedGalleryItems = () => {
    selectedGalleryItems.forEach((item, index) => {
      const seed = item.seed ?? Date.now();
      downloadImageUrl(item.url, `diffusion-${seed}-${index + 1}.png`);
    });
  };

  const deleteOutputs = async (items) => {
    if (items.length === 0) return false;
    const count = items.length;
    const confirmed = await showConfirm({
      title: count === 1 ? "Delete image?" : `Delete ${count} images?`,
      message: `This removes the image${count === 1 ? "" : "s"} and ${count === 1 ? "its" : "their"} metadata from your drive.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return false;

    try {
      await deleteGeneratedOutputs(items);
      const removed = new Set(items);
      setGeneratedImages((prev) => prev.filter((img) => !removed.has(img)));
      setSelectedGalleryIndexes([]);

      if (items.some((item) => item.url === outputImage)) {
        setOutputImage(null);
        setOutputSeed(null);
        setGenDuration(null);
      }
      return true;
    } catch (err) {
      console.error("Failed to delete outputs:", err);
      showAlert({
        title: "Could not delete",
        message: err.message || String(err),
        danger: true,
      });
      return false;
    }
  };

  const deleteSelectedGalleryItems = () => deleteOutputs(selectedGalleryItems);

  const deleteViewerItem = async (item) => {
    const index = generatedImages.indexOf(item);
    const deleted = await deleteOutputs([item]);
    if (!deleted) return;
    const next = generatedImages.filter((img) => img !== item);
    if (next.length === 0) {
      closeViewer();
    } else {
      setViewerUrl(next[Math.min(index, next.length - 1)].url);
    }
  };

  // ---- Composer ----
  const canGenerate = Boolean(prompt.trim()) && Boolean(activeModel) && !isBusy;

  const submit = () => {
    if (!canGenerate) return;
    setOpenMenu(null);
    handleGenerate();
  };

  const handleComposerKeyDown = (event) => {
    if (event.key === "Escape" && openMenu) {
      event.stopPropagation();
      setOpenMenu(null);
    }
  };

  const seedIsRandom = constraints.seed === -1 || constraints.seed === undefined || constraints.seed === null;
  const modelLabel = activeModel ? modelDisplayName(activeModel) : "Choose model";
  const imageCount = generatedImages.length;
  const showProgressTile = isBusy;

  const progressTile = showProgressTile && (
    <div className="images-tile images-progress-tile" role="group" aria-label="Generation progress">
      <div className="images-spinner" aria-hidden="true" />
      {isRestartingBackend ? (
        <>
          <div className="images-progress-phase">
            {restartLoadProgress?.phase || "Loading model"}
          </div>
          <div className="images-progress-meta">
            {restartLoadProgress
              ? restartLoadProgress.total > 0
                ? `${restartLoadProgress.current} / ${restartLoadProgress.total} tensors`
                : `${Math.round(restartLoadProgress.progress)}%`
              : "Applying settings and starting the model"}
          </div>
          {restartLoadProgress && (
            <div className="images-progress-bar" aria-hidden="true">
              <div
                className="images-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, restartLoadProgress.progress))}%` }}
              />
            </div>
          )}
          {restartLoadProgress && (restartLoadProgress.backendMode || restartLoadProgress.device) && (
            <div className="images-progress-meta">
              {restartLoadProgress.backendMode || "Backend"}{restartLoadProgress.device ? ` · ${restartLoadProgress.device}` : ""}
            </div>
          )}
        </>
      ) : isCancelling ? (
        <>
          <div className="images-progress-phase">Stopping</div>
          <div className="images-progress-meta">Reloading the model for the next image</div>
        </>
      ) : (
        <>
          <div className="images-progress-phase">{isDecoding ? "Decoding latents" : "Generating"}</div>
          <div className="images-progress-meta">
            Step {currentStep} / {constraints.steps}
          </div>
          <div className="images-progress-bar" aria-hidden="true">
            <div className="images-progress-fill" style={{ width: `${generationProgress}%` }} />
          </div>
          <div className="images-progress-meta">
            {generationProgress}% · {elapsedTime}s
            {generationSpeed && generationSpeed !== "decoding" ? ` · ${generationSpeed}` : ""}
            {estimatedLeftTime > 0 ? ` · ~${estimatedLeftTime}s left` : ""}
          </div>
          {isCpuFallback && (
            <div className="images-progress-warning">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>Running on CPU, slower than expected</span>
            </div>
          )}
          {isGenerating && (
            <button type="button" className="btn images-progress-stop" onClick={handleCancelGeneration}>
              Stop
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="page images-page">
      <div className="page-scroll">
        <div className="page-column">
          <header className="page-header">
            <h1 className="page-title">Images</h1>
            {imageCount > 0 && (
              <div className="images-header-actions">
                {selectedGalleryItems.length > 0 ? (
                  <>
                    <span className="images-count">{selectedGalleryItems.length} selected</span>
                    <button type="button" className="icon-btn" onClick={useSelectedGalleryItem} aria-label="Reuse prompt and settings" title="Reuse prompt and settings">
                      <RefreshCw size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn" onClick={downloadSelectedGalleryItems} aria-label="Download selected" title="Download selected">
                      <Download size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn danger" onClick={deleteSelectedGalleryItems} aria-label="Delete selected" title="Delete selected">
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn" onClick={clearGallerySelection} aria-label="Clear selection" title="Clear selection">
                      <X size={16} aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <span className="images-count">{imageCount} image{imageCount === 1 ? "" : "s"}</span>
                )}
                <button
                  type="button"
                  className={`btn ${selectMode ? "images-btn-on" : ""}`}
                  onClick={toggleSelectMode}
                  aria-pressed={selectMode}
                  title="Select images. Ctrl-click or Shift-click also selects."
                >
                  {selectMode ? "Done" : "Select"}
                </button>
              </div>
            )}
          </header>

          {errorMsg && !isBusy && (
            <div className="images-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <div className="images-error-text">
                <div>{errorMsg}</div>
                {textModelBlocking ? (
                  <button type="button" className="btn images-error-action" onClick={handleUnloadTextAndGenerate}>
                    Unload text model and generate
                  </button>
                ) : (
                  <div className="images-error-hint">If this keeps happening, try a smaller size such as 512×512.</div>
                )}
              </div>
              <button type="button" className="icon-btn" onClick={() => setErrorMsg(null)} aria-label="Dismiss error">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          )}

          {imageCount === 0 && !showProgressTile ? (
            <div className="empty-state images-empty">
              <div className="empty-state-title">Create your first image</div>
              <div>Describe it below and press Enter. Images are saved on your drive.</div>
            </div>
          ) : (
            <div className="images-grid">
              {progressTile}
              {generatedImages.map((img, idx) => (
                <GalleryItem
                  key={img.image || img.url || idx}
                  img={img}
                  idx={idx}
                  isSelected={selectedGalleryIndexes.includes(idx)}
                  selectMode={selectMode}
                  onActivate={handleTileActivate}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="page-dock">
        <div className="chat-composer images-composer" ref={composerRef} onKeyDown={handleComposerKeyDown}>
          {baseImage && !isNpuBackend && (
            <div className="chat-attachments">
              <div className="chat-attachment images-base-attachment">
                <img src={baseImage} alt="" className="chat-attachment-thumb" />
                <span className="chat-attachment-name">Base image</span>
                <button
                  type="button"
                  className="chat-attachment-remove"
                  onClick={handleClearBaseImage}
                  disabled={isBusy}
                  aria-label="Remove base image"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              <label className="images-strength" title="Lower stays closer to your image; higher gives more freedom. 0.7 is a good start.">
                <span className="images-strength-label">Strength</span>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={constraints.denoisingStrength}
                  onChange={(e) => setConstraints((prev) => ({ ...prev, denoisingStrength: parseFloat(e.target.value) }))}
                  disabled={isBusy}
                  aria-label="Transformation strength"
                />
                <span className="images-strength-value">{Number(constraints.denoisingStrength).toFixed(2)}</span>
              </label>
            </div>
          )}

          <div className="chat-composer-inner">
            <textarea
              ref={textareaRef}
              className="chat-composer-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={activeModel ? "Describe an image" : "Choose an image model to start"}
              aria-label="Image prompt"
              rows={1}
            />

            <div className="chat-composer-toolbar">
              <div className="chat-composer-toolbar-left">
                {!isNpuBackend && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="images-hidden-input"
                      onChange={handleBaseImageSelect}
                      disabled={isBusy}
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      className="chat-composer-icon-btn"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isBusy}
                      aria-label={baseImage ? "Replace base image" : "Add base image"}
                      title="Start from one of your own images"
                    >
                      <Plus size={20} aria-hidden="true" />
                    </button>
                  </>
                )}

                {/* Size */}
                <div className="images-menu-anchor">
                  <button
                    type="button"
                    className="chat-composer-chip"
                    onClick={() => toggleMenu("size")}
                    disabled={isBusy}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "size"}
                    aria-label={`Image size ${constraints.width} by ${constraints.height}`}
                  >
                    <span>{sizeLabel(constraints.width, constraints.height)}</span>
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                  {openMenu === "size" && (
                    <div className="chat-model-menu up images-menu-left images-size-menu" role="menu">
                      {SIZE_GROUPS.map((group, groupIndex) => (
                        <React.Fragment key={group.label}>
                          {groupIndex > 0 && <div className="chat-model-menu-divider" />}
                          <div className="chat-model-menu-label">{group.label}</div>
                          {group.sizes.map((size) => {
                            const selected = constraints.width === size.width && constraints.height === size.height;
                            return (
                              <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={selected}
                                key={`${size.width}x${size.height}`}
                                className={`chat-model-menu-item ${selected ? "selected" : ""}`}
                                onClick={() => {
                                  setConstraints((prev) => ({ ...prev, width: size.width, height: size.height }));
                                  setOpenMenu(null);
                                }}
                              >
                                <span className="chat-model-menu-name">{size.ratio}</span>
                                <span className="images-menu-meta">{size.width}×{size.height}</span>
                              </button>
                            );
                          })}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>

                {/* Steps */}
                <div className="images-menu-anchor">
                  <button
                    type="button"
                    className="chat-composer-chip"
                    onClick={() => toggleMenu("steps")}
                    disabled={isBusy}
                    aria-haspopup="dialog"
                    aria-expanded={openMenu === "steps"}
                  >
                    <span>{constraints.steps} steps</span>
                  </button>
                  {openMenu === "steps" && (
                    <div className="popover images-popover" role="dialog" aria-label="Steps">
                      <div className="field">
                        <label className="field-label" htmlFor="images-steps">Steps</label>
                        <div className="images-range-row">
                          <input
                            type="range"
                            min="1"
                            max={maxSteps}
                            value={constraints.steps}
                            onChange={(e) => handleStepsChange(e.target.value)}
                            aria-label="Steps slider"
                          />
                          <input
                            id="images-steps"
                            type="number"
                            className="images-input images-input-small"
                            min="1"
                            max={maxSteps}
                            value={constraints.steps}
                            onChange={(e) => handleStepsChange(e.target.value)}
                          />
                        </div>
                        <div className="field-hint">More steps add detail but take longer.</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Seed */}
                <div className="images-menu-anchor">
                  <button
                    type="button"
                    className="chat-composer-chip"
                    onClick={() => toggleMenu("seed")}
                    disabled={isBusy}
                    aria-haspopup="dialog"
                    aria-expanded={openMenu === "seed"}
                  >
                    <Dices size={15} aria-hidden="true" />
                    <span>{seedIsRandom ? "Random seed" : `Seed ${constraints.seed}`}</span>
                  </button>
                  {openMenu === "seed" && (
                    <div className="popover images-popover" role="dialog" aria-label="Seed">
                      <div className="field">
                        <span className="field-label">Seed</span>
                        <div className="segmented">
                          <button
                            type="button"
                            className="segmented-item"
                            aria-pressed={seedIsRandom}
                            onClick={() => updateConstraint("seed", -1)}
                          >
                            Random
                          </button>
                          <button
                            type="button"
                            className="segmented-item"
                            aria-pressed={!seedIsRandom}
                            onClick={() => {
                              if (seedIsRandom) updateConstraint("seed", Math.floor(Math.random() * 2147483647));
                            }}
                          >
                            Fixed
                          </button>
                        </div>
                      </div>
                      {!seedIsRandom && (
                        <div className="field">
                          <label className="field-label" htmlFor="images-seed">Seed number</label>
                          <input
                            id="images-seed"
                            type="number"
                            className="images-input"
                            value={constraints.seed}
                            onChange={(e) => updateConstraint("seed", parseInt(e.target.value) || -1)}
                          />
                          <div className="field-hint">The same seed and prompt give the same image.</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* More */}
                <div className="images-menu-anchor">
                  <button
                    type="button"
                    className={`chat-composer-chip ${negativePrompt?.trim() ? "images-chip-set" : ""}`}
                    onClick={() => toggleMenu("more")}
                    aria-haspopup="dialog"
                    aria-expanded={openMenu === "more"}
                  >
                    <SlidersHorizontal size={15} aria-hidden="true" />
                    <span>More</span>
                  </button>
                  {openMenu === "more" && (
                    <div className="popover images-popover images-popover-wide" role="dialog" aria-label="More settings">
                      <div className="field">
                        <label className="field-label" htmlFor="images-negative">Negative prompt</label>
                        <textarea
                          id="images-negative"
                          className="images-input images-textarea"
                          value={negativePrompt}
                          onChange={(e) => setNegativePrompt(e.target.value)}
                          placeholder="Things to avoid, such as blurry, text, watermark"
                          disabled={isBusy}
                          rows={3}
                        />
                      </div>
                      <div className="images-field-row">
                        <div className="field">
                          <label className="field-label" htmlFor="images-sampler">Sampler</label>
                          <select
                            id="images-sampler"
                            className="images-input"
                            value={constraints.sampler}
                            onChange={(e) => updateConstraint("sampler", e.target.value)}
                            disabled={isBusy}
                          >
                            {(SAMPLERS.includes(constraints.sampler) ? SAMPLERS : [constraints.sampler, ...SAMPLERS]).map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </div>
                        <div className="field">
                          <label className="field-label" htmlFor="images-cfg">CFG scale</label>
                          <input
                            id="images-cfg"
                            type="number"
                            className="images-input"
                            min="1"
                            max="30"
                            step="0.5"
                            value={constraints.cfgScale}
                            onChange={(e) => handleCfgChange(e.target.value)}
                            disabled={isBusy}
                          />
                        </div>
                      </div>
                      <div className="field-hint">How closely the image follows the prompt. Fast models work best near 1.</div>
                      <button
                        type="button"
                        className="btn images-popover-link"
                        onClick={() => {
                          setOpenMenu(null);
                          setActiveTab?.("settings");
                        }}
                      >
                        Hardware and backend settings
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="chat-composer-toolbar-right">
                <div className="chat-model-picker">
                  <button
                    type="button"
                    className={`chat-model-trigger ${openMenu === "model" ? "active" : ""}`}
                    onClick={() => toggleMenu("model")}
                    disabled={isBusy}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "model"}
                    title={activeModel || "Choose an image model"}
                  >
                    {backendReady && <span className="chat-model-dot" aria-hidden="true" />}
                    <span className="chat-model-trigger-label">{modelLabel}</span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                  {openMenu === "model" && (
                    <div className="chat-model-menu up" role="menu">
                      <div className="chat-model-menu-label">Image models</div>
                      {imageModels === null && (
                        <div className="chat-model-menu-item images-menu-static">
                          <span className="chat-model-menu-name">Looking for models…</span>
                        </div>
                      )}
                      {imageModels?.length === 0 && (
                        <div className="chat-model-menu-item images-menu-static">
                          <span className="chat-model-menu-name">No image models yet</span>
                        </div>
                      )}
                      {imageModels?.map((model) => {
                        const isSelected = activeModel === model.filename;
                        return (
                          <button
                            type="button"
                            role="menuitem"
                            key={model.filename}
                            className={`chat-model-menu-item ${isSelected ? "selected" : ""}`}
                            title={model.filename}
                            onClick={() => handlePickModel(model)}
                          >
                            <span className="chat-model-menu-name">{modelDisplayName(model.filename)}</span>
                            {isSelected && backendReady && <span className="chat-model-menu-badge">Loaded</span>}
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
                          setActiveTab?.("models");
                        }}
                      >
                        Manage models
                      </button>
                    </div>
                  )}
                </div>

                {isGenerating && !isCancelling ? (
                  <button
                    type="button"
                    className="chat-composer-stop-btn"
                    onClick={handleCancelGeneration}
                    aria-label="Stop generating"
                    title="Stop generating"
                  >
                    <Square size={14} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chat-composer-send-btn"
                    onClick={submit}
                    disabled={!canGenerate}
                    aria-label={baseImage ? "Generate from base image" : "Generate image"}
                    title={!activeModel ? "Choose an image model first" : baseImage ? "Generate from base image" : "Generate image"}
                  >
                    <ArrowUp size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {viewerItem && (
        <div className="images-viewer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeViewer(); }}>
          <div
            ref={viewerRef}
            className="images-viewer"
            role="dialog"
            aria-modal="true"
            aria-label="Image viewer"
            onKeyDown={handleViewerKeyDown}
          >
            <div className="images-viewer-top">
              <span className="images-count">
                {viewerIndex + 1} of {imageCount}
              </span>
              <button
                ref={viewerCloseRef}
                type="button"
                className="icon-btn"
                onClick={closeViewer}
                aria-label="Close viewer"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="images-viewer-stage">
              <button
                type="button"
                className="icon-btn images-viewer-nav"
                onClick={() => showViewerAt(viewerIndex - 1)}
                disabled={viewerIndex <= 0}
                aria-label="Previous image"
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
              <img src={viewerItem.url} alt={viewerItem.prompt || "Generated image"} className="images-viewer-img" />
              <button
                type="button"
                className="icon-btn images-viewer-nav"
                onClick={() => showViewerAt(viewerIndex + 1)}
                disabled={viewerIndex >= imageCount - 1}
                aria-label="Next image"
              >
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            </div>

            <div className="images-viewer-info">
              {viewerItem.prompt && <p className="images-viewer-prompt">{viewerItem.prompt}</p>}
              <div className="images-viewer-meta">
                {[
                  viewerItem.width && viewerItem.height ? `${viewerItem.width}×${viewerItem.height}` : null,
                  viewerItem.steps ? `${viewerItem.steps} steps` : null,
                  viewerItem.seed !== undefined && viewerItem.seed !== null ? `Seed ${viewerItem.seed}` : null,
                  viewerItem.duration_sec ? `${Number(viewerItem.duration_sec).toFixed(1)}s` : null,
                  viewerItem.model ? modelDisplayName(viewerItem.model) : null,
                ].filter(Boolean).join(" · ")}
              </div>
            </div>

            <div className="images-viewer-actions">
              <button
                type="button"
                className="btn"
                onClick={() => downloadImageUrl(viewerItem.url, `diffusion-${viewerItem.seed ?? Date.now()}.png`)}
              >
                <Download size={15} aria-hidden="true" />
                <span>Download</span>
              </button>
              <button type="button" className="btn" onClick={() => copyImageUrl(viewerItem.url)}>
                {copySuccess ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                <span>{copySuccess ? "Copied" : "Copy"}</span>
              </button>
              <button type="button" className="btn" onClick={() => reuseFromViewer(viewerItem)}>
                <RefreshCw size={15} aria-hidden="true" />
                <span>Reuse prompt</span>
              </button>
              {!isNpuBackend && (
                <button type="button" className="btn" onClick={() => applyAsBaseImage(viewerItem)} disabled={isBusy}>
                  <ImagePlus size={15} aria-hidden="true" />
                  <span>Use as base image</span>
                </button>
              )}
              <button type="button" className="btn btn-danger images-viewer-delete" onClick={() => deleteViewerItem(viewerItem)}>
                <Trash2 size={15} aria-hidden="true" />
                <span>Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(Generator);
