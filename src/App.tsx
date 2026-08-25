import { useState, useRef, useEffect, ChangeEvent, useMemo, useCallback } from 'react';
import {
  parseTimelineJson,
  parseRawSignalsJson,
  processRawSignals,
  availableMonths,
  pointDateKey,
  localDateKey,
  TimelineParseError,
  RawSignalPoint,
} from './timeline';
import type { GeoPoint, MonthOption, CameraMovement, PreparedJourney, RenderSize } from './types';
import { filterLocationOutliers, type LocationFilterMode } from './outlier';
import { selectTimelineModePoints } from './selection';
import { prepareJourney, drawFrame, previewCanvasSize, OverlayText } from './renderer';
import { totalDurationSeconds, frameAtElapsedSeconds } from './animation';
import {
  createJourneyMp4,
  hasVideoEncoder,
  VIDEO_FORMATS,
  VIDEO_FRAME_RATES,
  videoFormatAtFrameRate,
  videoFormatByKey,
  probeVideoFormats,
  resolveVideoFormat,
  type VideoFormat,
  type VideoFormatSupport,
  type VideoFrameRate,
  DEFAULT_VIDEO_FORMAT_KEY,
} from './video';
import {
  readLanguagePreference,
  writeLanguagePreference,
  activeLocale,
  createI18n,
  formattingLocale,
  LOCALES,
  LANGUAGE_NAMES,
  type LanguagePreference,
} from './i18n';
import {
  readDistanceUnitPreference,
  writeDistanceUnitPreference,
  resolveDistanceUnit,
  type DistanceUnitPreference,
} from './distance-unit';
import { formatRawDateRange } from './raw-range';
import { parsePresetToken, presetIntentUrl } from './preset-link';
import { AppError } from './errors';
import { cumulativeDistances } from './geo';

function browserLanguages(): readonly string[] {
  return navigator.languages ?? [navigator.language];
}

function buildI18n(preference: LanguagePreference) {
  const tags = browserLanguages();
  const locale = activeLocale(preference, tags);
  return createI18n(locale, formattingLocale(preference, tags, locale));
}

const DURATION_OPTIONS = [5, 10, 15, 20, 30, 45, 60];

export default function App() {
  const [langPref, setLangPref] = useState<LanguagePreference>(() => readLanguagePreference());
  const i18n = useMemo(() => buildI18n(langPref), [langPref]);

  const [distPref, setDistPref] = useState<DistanceUnitPreference>(() => readDistanceUnitPreference());
  const distanceUnit = useMemo(() => resolveDistanceUnit(distPref, browserLanguages()), [distPref]);

  // Video format support probing
  const [formatSupport, setFormatSupport] = useState<VideoFormatSupport | null>(null);
  const [isCheckingSupport, setIsCheckingSupport] = useState(true);

  // File and points state
  const [fileStatus, setFileStatus] = useState<string>(() => i18n.t('fileStatusEmpty'));
  const [fileStatusIsError, setFileStatusIsError] = useState(false);
  const [semanticPoints, setSemanticPoints] = useState<GeoPoint[]>([]);
  const [rawPoints, setRawPoints] = useState<RawSignalPoint[]>([]);
  const [months, setMonths] = useState<MonthOption[]>([]);
  const [allDateKeys, setAllDateKeys] = useState<string[]>([]);

  // Settings
  const [useRaw, setUseRaw] = useState(false);
  const [rawLimit, setRawLimit] = useState(100);
  const [filterMode, setFilterMode] = useState<LocationFilterMode>('conservative');
  const [exactDates, setExactDates] = useState(false);

  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(15);
  const [cameraMovement, setCameraMovement] = useState<CameraMovement>('steady');
  const [formatKey, setFormatKey] = useState<string>(DEFAULT_VIDEO_FORMAT_KEY);
  const [frameRateVal, setFrameRateVal] = useState<'recommended' | VideoFrameRate>('recommended');

  const [mapConsent, setMapConsent] = useState(false);
  const [settingsError, setSettingsError] = useState<string>('');

  // Processing & Preview state
  const [isPreparing, setIsPreparing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressFraction, setProgressFraction] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const [preparedJourney, setPreparedJourney] = useState<PreparedJourney | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);

  // Export output
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);
  const [videoFileSizeMb, setVideoFileSizeMb] = useState<string | null>(null);

  // Abort controller ref for cancellation
  const abortControllerRef = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const animationStartTimeRef = useRef<number | null>(null);

  // Preset token detection in query params
  const presetToken = useMemo(() => {
    try {
      return parsePresetToken(window.location.search);
    } catch {
      return null;
    }
  }, []);

  // Check video encoding support on mount
  useEffect(() => {
    let mounted = true;
    probeVideoFormats()
      .then((support) => {
        if (mounted) {
          setFormatSupport(support);
          setIsCheckingSupport(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setIsCheckingSupport(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Update language and distance unit storage
  useEffect(() => {
    writeLanguagePreference(langPref);
  }, [langPref]);

  useEffect(() => {
    writeDistanceUnitPreference(distPref);
  }, [distPref]);

  // Set default title if empty when locale changes
  useEffect(() => {
    if (!title || title === 'My Journey' || title === '내 여행' || title === 'マイジャーニー') {
      setTitle(i18n.t('defaultVideoTitle'));
    }
  }, [i18n, title]);

  // Resolved video format object
  const activeVideoFormat = useMemo((): VideoFormat => {
    const base = videoFormatByKey(formatKey) ?? VIDEO_FORMATS[0];
    const fps: VideoFrameRate = frameRateVal === 'recommended' ? (base.frameRate as VideoFrameRate) : frameRateVal;
    return videoFormatAtFrameRate(base, fps);
  }, [formatKey, frameRateVal]);

  const resolvedFormat = useMemo(() => {
    if (!formatSupport) return null;
    return resolveVideoFormat(activeVideoFormat, formatSupport);
  }, [activeVideoFormat, formatSupport]);

  // Selected Points Calculation
  const filteredSemanticPoints = useMemo(() => {
    if (semanticPoints.length === 0) return [];
    return filterLocationOutliers(semanticPoints, filterMode).points;
  }, [semanticPoints, filterMode]);

  const rawProcessingResult = useMemo(() => {
    if (rawPoints.length === 0) return null;
    return processRawSignals(rawPoints, rawLimit > 0 ? rawLimit : null);
  }, [rawPoints, rawLimit]);

  const activePoints = useMemo(() => {
    const currentRaw = rawProcessingResult ? rawProcessingResult.points : [];
    return selectTimelineModePoints(useRaw, currentRaw, filteredSemanticPoints, {
      exactDates,
      startMonth,
      endMonth,
      startDate,
      endDate,
    });
  }, [useRaw, rawProcessingResult, filteredSemanticPoints, exactDates, startMonth, endMonth, startDate, endDate]);

  // Total summary of selected points
  const pointsSummary = useMemo(() => {
    if (activePoints.length === 0) {
      return i18n.t('summaryNoLocations');
    }
    if (activePoints.length === 1) {
      return i18n.t('summaryOneLocation');
    }
    const dists = cumulativeDistances(activePoints);
    const totalKm = dists[dists.length - 1] ?? 0;
    const distanceStr = i18n.formatDistance(totalKm, distanceUnit);

    const clauses: string[] = [];
    if (totalKm < 0.05) {
      clauses.push(i18n.t('summaryNoMovement', { count: activePoints.length }));
    } else if (useRaw) {
      clauses.push(i18n.t('summaryDistanceEstimated', { count: activePoints.length, distance: distanceStr }));
    } else {
      clauses.push(i18n.t('summaryDistanceAbout', { count: activePoints.length, distance: distanceStr }));
    }

    if (!useRaw && filterMode === 'conservative') {
      const removed = filterLocationOutliers(semanticPoints, 'conservative').removedCount;
      if (removed > 0) {
        clauses.push(i18n.t('summaryOutliersIgnored', { count: removed }));
      }
    } else if (useRaw && rawProcessingResult && rawProcessingResult.rejectedCount > 0) {
      clauses.push(i18n.t('summaryRawRejected', { count: rawProcessingResult.rejectedCount }));
    }

    return clauses.join(i18n.strings.listSeparator);
  }, [activePoints, useRaw, filterMode, semanticPoints, rawProcessingResult, i18n, distanceUnit]);

  // Overlay text preparation
  const getOverlayText = useCallback((): OverlayText => {
    let periodLabel = '';
    if (useRaw) {
      periodLabel = i18n.t('periodRawLocationData');
    } else if (exactDates) {
      if (startDate && endDate) {
        if (startDate === endDate) {
          const d = new Date(`${startDate}T00:00:00Z`);
          periodLabel = i18n.formatMediumDate(d);
        } else {
          const s = i18n.formatMediumDate(new Date(`${startDate}T00:00:00Z`));
          const e = i18n.formatMediumDate(new Date(`${endDate}T00:00:00Z`));
          periodLabel = i18n.t('periodRange', { start: s, end: e });
        }
      }
    } else if (startMonth && endMonth) {
      if (startMonth === endMonth) {
        const [y, m] = startMonth.split('-').map(Number);
        periodLabel = i18n.formatMonth(new Date(y, m - 1, 1));
      } else {
        const [sy, sm] = startMonth.split('-').map(Number);
        const [ey, em] = endMonth.split('-').map(Number);
        const s = i18n.formatMonth(new Date(sy, sm - 1, 1));
        const e = i18n.formatMonth(new Date(ey, em - 1, 1));
        periodLabel = i18n.t('periodRange', { start: s, end: e });
      }
    }

    return {
      title: title.trim() || i18n.t('defaultVideoTitle'),
      periodLabel,
      separator: ' · ',
      formatDistance: (km: number) => i18n.formatDistance(km, distanceUnit),
    };
  }, [useRaw, exactDates, startDate, endDate, startMonth, endMonth, title, i18n, distanceUnit]);

  // Load JSON helper
  const loadTimelineData = (data: unknown, sourceName: string) => {
    try {
      setErrorMessage('');
      setSettingsError('');
      setPreparedJourney(null);
      setVideoBlobUrl(null);

      const parsedRaw = parseRawSignalsJson(data);
      const parsedSemantic = parseTimelineJson(data);

      setRawPoints(parsedRaw);
      setSemanticPoints(parsedSemantic);

      const pts = parsedSemantic.length > 0 ? parsedSemantic : parsedRaw;
      if (pts.length === 0) {
        throw new TimelineParseError('no-usable-locations', 'No usable locations found.');
      }

      const m = availableMonths(pts, i18n.formatLocale);
      setMonths(m);
      if (m.length > 0) {
        setStartMonth(m[0].key);
        setEndMonth(m[m.length - 1].key);
      }

      const dateKeys = pts.map(pointDateKey).sort();
      setAllDateKeys(dateKeys);
      if (dateKeys.length > 0) {
        setStartDate(dateKeys[0]);
        setEndDate(dateKeys[dateKeys.length - 1]);
      }

      if (parsedSemantic.length === 0 && parsedRaw.length > 0) {
        setUseRaw(true);
      }

      setFileStatus(
        i18n.t('fileStatusLoaded', {
          count: pts.length,
          source: sourceName,
          firstMonth: m[0]?.label || '',
          lastMonth: m[m.length - 1]?.label || '',
        })
      );
      setFileStatusIsError(false);
    } catch (err: unknown) {
      setFileStatusIsError(true);
      if (err instanceof TimelineParseError) {
        if (err.reason === 'no-usable-locations') setFileStatus(i18n.t('errorNoUsableLocations'));
        else if (err.reason === 'malformed-json') setFileStatus(i18n.t('errorMalformedJson'));
        else if (err.reason === 'legacy-format') setFileStatus(i18n.t('errorLegacyFormat'));
        else setFileStatus(i18n.t('errorUnsupportedFormat'));
      } else {
        setFileStatus(i18n.t('fileStatusLoadFailed'));
      }
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileStatus(i18n.t('fileStatusReading', { name: file.name }));
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      loadTimelineData(data, file.name);
    } catch (err: unknown) {
      setFileStatusIsError(true);
      setFileStatus(i18n.t('fileStatusLoadFailed'));
    }
  };

  const handleLoadSample = async () => {
    setFileStatus(i18n.t('fileStatusLoadingSample'));
    try {
      const resp = await fetch('/sample-timeline.json');
      if (!resp.ok) throw new Error('Sample not found');
      const data = await resp.json();
      loadTimelineData(data, i18n.t('sampleSourceName'));
    } catch (err: unknown) {
      setFileStatusIsError(true);
      setFileStatus(i18n.t('fileStatusSampleFailed'));
    }
  };

  // Render a specific frame onto the preview canvas
  const renderFrameOnCanvas = useCallback(
    (journey: PreparedJourney, frameProgress: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const formatSize: RenderSize = {
        width: journey.size.width,
        height: journey.size.height,
      };
      const rect = canvas.getBoundingClientRect();
      const scaled = previewCanvasSize(formatSize, rect.width, window.devicePixelRatio || 1);

      if (canvas.width !== scaled.width || canvas.height !== scaled.height) {
        canvas.width = scaled.width;
        canvas.height = scaled.height;
      }

      const totalSec = totalDurationSeconds(duration);
      const elapsed = frameProgress * totalSec;
      const timelineFrame = frameAtElapsedSeconds(elapsed, duration);
      const overlayText = getOverlayText();

      drawFrame(canvas, journey, timelineFrame, overlayText);
    },
    [duration, getOverlayText]
  );

  // Playback animation loop
  const stopAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    animationStartTimeRef.current = null;
    setIsPlaying(false);
  }, []);

  const startAnimation = useCallback(
    (journey: PreparedJourney, startProgress = 0) => {
      stopAnimation();
      setIsPlaying(true);

      const totalSec = totalDurationSeconds(duration);
      let startTime: number | null = null;

      const tick = (now: number) => {
        if (!startTime) {
          startTime = now - startProgress * totalSec * 1000;
          animationStartTimeRef.current = startTime;
        }

        const elapsed = (now - startTime) / 1000;
        let progress = elapsed / totalSec;

        if (progress >= 1) {
          progress = 1;
          renderFrameOnCanvas(journey, 1);
          setPlaybackProgress(1);
          setProgressMsg(i18n.t('progressPreviewComplete'));
          setIsPlaying(false);
          animationFrameRef.current = null;
          return;
        }

        renderFrameOnCanvas(journey, progress);
        setPlaybackProgress(progress);
        animationFrameRef.current = requestAnimationFrame(tick);
      };

      animationFrameRef.current = requestAnimationFrame(tick);
    },
    [duration, i18n, renderFrameOnCanvas, stopAnimation]
  );

  // Clean up animation on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Handle Preview Action
  const handlePreview = async () => {
    if (!mapConsent) {
      setSettingsError(i18n.t('errorMapConsent'));
      return;
    }
    if (activePoints.length < 2) {
      setSettingsError(i18n.t('errorTooFewPoints'));
      return;
    }

    setSettingsError('');
    setErrorMessage('');
    stopAnimation();
    setIsPreparing(true);
    setProgressMsg(i18n.t('progressPreparingMap'));
    setProgressFraction(0);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const renderSize: RenderSize = {
        width: activeVideoFormat.width,
        height: activeVideoFormat.height,
      };

      const journey = await prepareJourney(
        activePoints,
        renderSize,
        cameraMovement,
        duration,
        controller.signal,
        (completed, total) => {
          setProgressMsg(i18n.t('progressPreparingMapCount', { completed, total }));
          setProgressFraction(total > 0 ? completed / total : 0);
        }
      );

      setPreparedJourney(journey);
      setIsPreparing(false);
      setProgressMsg(i18n.t('progressPreviewing'));
      setProgressFraction(null);

      // Start the animated preview
      startAnimation(journey, 0);
    } catch (err: unknown) {
      setIsPreparing(false);
      if (err instanceof DOMException && err.name === 'AbortError') {
        setProgressMsg(i18n.t('progressCancelled'));
      } else if (err instanceof AppError) {
        setErrorMessage(i18n.t(err.code));
        setProgressMsg(i18n.t('progressFailed'));
      } else {
        setErrorMessage(i18n.t('errorPreviewFailed'));
        setProgressMsg(i18n.t('progressFailed'));
      }
    } finally {
      abortControllerRef.current = null;
    }
  };

  // Handle Create MP4 Action
  const handleCreateMp4 = async () => {
    if (!mapConsent) {
      setSettingsError(i18n.t('errorMapConsent'));
      return;
    }
    if (activePoints.length < 2) {
      setSettingsError(i18n.t('errorTooFewPoints'));
      return;
    }
    if (!resolvedFormat) {
      setSettingsError(i18n.t('errorFormatUnsupported', { width: activeVideoFormat.width, height: activeVideoFormat.height }));
      return;
    }

    setSettingsError('');
    setErrorMessage('');
    stopAnimation();
    setIsExporting(true);
    setProgressMsg(i18n.t('progressPreparingMap'));
    setProgressFraction(0);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const renderSize: RenderSize = {
        width: resolvedFormat.width,
        height: resolvedFormat.height,
      };

      // Prepare map & tiles
      const journey = await prepareJourney(
        activePoints,
        renderSize,
        cameraMovement,
        duration,
        controller.signal,
        (completed, total) => {
          setProgressMsg(i18n.t('progressPreparingMapCount', { completed, total }));
          setProgressFraction(total > 0 ? (completed / total) * 0.4 : 0);
        }
      );

      setPreparedJourney(journey);
      setProgressMsg(i18n.t('progressCreating'));

      // Create an offscreen / export canvas of exact format dimensions
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = resolvedFormat.width;
      exportCanvas.height = resolvedFormat.height;

      const overlay = getOverlayText();

      const blob = await createJourneyMp4(exportCanvas, journey, {
        durationSeconds: duration,
        overlay,
        format: resolvedFormat,
        signal: controller.signal,
        onProgress: (fraction) => {
          const percent = i18n.formatPercent(fraction);
          setProgressMsg(i18n.t('progressCreatingPercent', { percent }));
          setProgressFraction(0.4 + fraction * 0.6);
        },
      });

      const url = URL.createObjectURL(blob);
      setVideoBlobUrl(url);

      const sizeMb = (blob.size / (1024 * 1024)).toFixed(1);
      setVideoFileSizeMb(sizeMb);
      setProgressMsg(i18n.t('progressVideoReady', { size: sizeMb }));
      setProgressFraction(1);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setProgressMsg(i18n.t('progressCancelled'));
      } else if (err instanceof AppError) {
        setErrorMessage(i18n.t(err.code));
        setProgressMsg(i18n.t('progressFailed'));
      } else {
        setErrorMessage(i18n.t('errorExportFailed'));
        setProgressMsg(i18n.t('progressFailed'));
      }
    } finally {
      setIsExporting(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelOperation = () => {
    if (abortControllerRef.current) {
      setProgressMsg(i18n.t('progressCancelling'));
      abortControllerRef.current.abort();
    }
  };

  const handleShareVideo = async () => {
    if (!videoBlobUrl) return;
    try {
      const response = await fetch(videoBlobUrl);
      const blob = await response.blob();
      const file = new File([blob], `${title.trim() || 'journey'}.mp4`, { type: 'video/mp4' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: title.trim() || i18n.t('defaultVideoTitle'),
        });
      } else {
        // Fallback to download
        handleDownloadVideo();
      }
    } catch {
      handleDownloadVideo();
    }
  };

  const handleDownloadVideo = () => {
    if (!videoBlobUrl) return;
    const a = document.createElement('a');
    a.href = videoBlobUrl;
    a.download = `${(title.trim() || 'journey').replace(/[^\w\s-]/gi, '')}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Browser video encoder compatibility status
  const compatibilityStatus = useMemo(() => {
    if (isCheckingSupport) return i18n.t('compatibilityChecking');
    if (!hasVideoEncoder()) return i18n.t('compatibilityPreviewOnly');
    if (!formatSupport) return i18n.t('compatibilityPreviewOnly');

    const totalCount = ALL_VIDEO_FORMATS_COUNT;
    let supportedCount = 0;
    for (const val of formatSupport.values()) {
      if (val !== null) supportedCount += 1;
    }
    if (supportedCount === totalCount) return i18n.t('compatibilityFull');
    if (supportedCount > 0) return i18n.t('compatibilityPartial');
    return i18n.t('compatibilityPreviewOnly');
  }, [isCheckingSupport, formatSupport, i18n]);

  const ALL_VIDEO_FORMATS_COUNT = VIDEO_FORMATS.length * VIDEO_FRAME_RATES.length;

  return (
    <main className="shell">
      {presetToken && (
        <div className="preview-banner mb-4">
          <strong>{i18n.t('presetLinkTitle')}: </strong>
          <span>{i18n.t('presetLinkBody')}</span>
          <div className="mt-2">
            <a
              href={presetIntentUrl(presetToken, window.location.href)}
              className="inline-block font-bold underline text-[#6e173d]"
            >
              {i18n.t('presetLinkOpen')}
            </a>
          </div>
        </div>
      )}

      <header className="app-header">
        <h1 id="app-title">{i18n.t('headerTitle')}</h1>
      </header>

      {/* Timeline File Card */}
      <section className="card intro" id="file-card">
        <h2 id="file-card-title">{i18n.t('fileCardTitle')}</h2>
        <p>{i18n.t('fileCardIntro')}</p>

        <details className="help-panel my-3">
          <summary id="export-help-toggle">{i18n.t('exportHelpSummary')}</summary>
          <ol className="mt-2 text-sm text-[#5c4b52] list-decimal pl-5 space-y-1">
            <li>{i18n.t('exportHelpStep1')}</li>
            <li>{i18n.t('exportHelpStep2')}</li>
            <li>{i18n.t('exportHelpStep3')}</li>
            <li>{i18n.t('exportHelpStep4')}</li>
          </ol>
        </details>

        <div className="source-actions grid gap-3 mt-4">
          <label className="file-button cursor-pointer flex min-h-12 w-full items-center justify-center rounded-xl bg-[#e90064] px-4 py-2 font-bold text-white text-center hover:opacity-95 transition-opacity" id="choose-file-label">
            <span>{i18n.t('chooseFileButton')}</span>
            <input type="file" accept=".json" onChange={handleFileUpload} className="hidden" id="timeline-file-input" />
          </label>
          <button
            type="button"
            onClick={handleLoadSample}
            className="w-full rounded-xl bg-[#f9dbe8] text-[#5c1840] font-bold p-3 hover:bg-[#f3ccde] transition-colors"
            id="load-sample-btn"
          >
            {i18n.t('sampleButton')}
          </button>
        </div>

        <p className={`status mt-3 text-sm ${fileStatusIsError ? 'text-[#a4002f] font-bold' : 'text-[#5c4b52]'}`} id="file-status-text">
          {fileStatus}
        </p>

        <div className="field-grid mt-4">
          <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="language-select-label">
            <span>{i18n.t('languageLabel')}</span>
            <select
              value={langPref}
              onChange={(e) => setLangPref(e.target.value as LanguagePreference)}
              disabled={isPreparing || isExporting}
              className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
              id="language-select"
            >
              <option value="system">{i18n.t('languageSystemDefault')}</option>
              {LOCALES.map((loc) => (
                <option key={loc} value={loc}>
                  {LANGUAGE_NAMES[loc]}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="distance-unit-select-label">
            <span>{i18n.t('distanceUnitLabel')}</span>
            <select
              value={distPref}
              onChange={(e) => setDistPref(e.target.value as DistanceUnitPreference)}
              disabled={isPreparing || isExporting}
              className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
              id="distance-unit-select"
            >
              <option value="automatic">
                {i18n.t('distanceUnitAutomaticResolved', {
                  automatic: i18n.t('distanceUnitAutomatic'),
                  resolved: distanceUnit === 'miles' ? i18n.t('distanceUnitMiles') : i18n.t('distanceUnitKilometers'),
                })}
              </option>
              <option value="kilometers">{i18n.t('distanceUnitKilometers')}</option>
              <option value="miles">{i18n.t('distanceUnitMiles')}</option>
            </select>
          </label>
        </div>

        <div className="mt-3 text-xs text-[#7b6570]" id="compatibility-status-text">
          {compatibilityStatus}
        </div>
      </section>

      {/* Settings Card */}
      {(semanticPoints.length > 0 || rawPoints.length > 0) && (
        <section className="card" id="settings-card">
          <h2 id="settings-title">{i18n.t('settingsTitle')}</h2>

          {/* Raw signals toggle if available */}
          {rawPoints.length > 0 && (
            <div className="mb-4 p-3 rounded-xl border border-[#ecd2dd] bg-[#fff8fb]">
              <label className="checkbox-row flex items-center gap-2 cursor-pointer font-bold" id="raw-signals-label">
                <input
                  type="checkbox"
                  checked={useRaw}
                  onChange={(e) => setUseRaw(e.target.checked)}
                  disabled={isPreparing || isExporting}
                  className="w-5 h-5 accent-[#e90064]"
                  id="raw-signals-toggle"
                />
                <span>{i18n.t('rawSignalsToggle')}</span>
              </label>
              <p className="text-xs text-[#7b6570] mt-1">{i18n.t('rawSignalsDescription')}</p>
              {useRaw && (
                <div className="mt-3 grid gap-2">
                  <label className="grid gap-1 text-sm font-bold text-[#493a40]" id="raw-accuracy-label">
                    <span>{i18n.t('accuracyLimitLabel')}</span>
                    <input
                      type="number"
                      min="10"
                      max="5000"
                      step="10"
                      value={rawLimit}
                      onChange={(e) => setRawLimit(Number(e.target.value) || 0)}
                      className="w-full rounded-xl border border-[#d9cdd2] p-2.5"
                      id="raw-accuracy-input"
                    />
                    <span className="field-help text-xs text-[#7b6570]">{i18n.t('accuracyLimitHelp')}</span>
                  </label>
                  <p className="text-xs font-semibold text-[#5c4b52] mt-1">
                    {formatRawDateRange(rawProcessingResult?.points || [], i18n)}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Outlier filter (for semantic mode) */}
          {!useRaw && (
            <label className="grid gap-1 font-bold text-sm text-[#493a40] mb-3" id="outlier-filter-label">
              <span>{i18n.t('locationFilterLabel')}</span>
              <select
                value={filterMode}
                onChange={(e) => setFilterMode(e.target.value as LocationFilterMode)}
                disabled={isPreparing || isExporting}
                className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
                id="outlier-filter-select"
              >
                <option value="conservative">{i18n.t('locationFilterConservative')}</option>
                <option value="off">{i18n.t('locationFilterOff')}</option>
              </select>
              <span className="field-help text-xs text-[#7b6570]">{i18n.t('locationFilterHelp')}</span>
            </label>
          )}

          {/* Date range controls */}
          {!useRaw && (
            <div className="grid gap-3 mb-4">
              <label className="checkbox-row flex items-center gap-2 cursor-pointer font-bold" id="exact-dates-label">
                <input
                  type="checkbox"
                  checked={exactDates}
                  onChange={(e) => setExactDates(e.target.checked)}
                  disabled={isPreparing || isExporting}
                  className="w-5 h-5 accent-[#e90064]"
                  id="exact-dates-toggle"
                />
                <span>{i18n.t('exactDatesToggle')}</span>
              </label>

              {exactDates ? (
                <div className="field-grid">
                  <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="start-date-label">
                    <span>{i18n.t('startDateLabel')}</span>
                    <input
                      type="date"
                      value={startDate}
                      min={allDateKeys[0]}
                      max={endDate || allDateKeys[allDateKeys.length - 1]}
                      onChange={(e) => setStartDate(e.target.value)}
                      disabled={isPreparing || isExporting}
                      className="w-full rounded-xl border border-[#d9cdd2] p-2.5"
                      id="start-date-input"
                    />
                  </label>
                  <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="end-date-label">
                    <span>{i18n.t('endDateLabel')}</span>
                    <input
                      type="date"
                      value={endDate}
                      min={startDate || allDateKeys[0]}
                      max={allDateKeys[allDateKeys.length - 1]}
                      onChange={(e) => setEndDate(e.target.value)}
                      disabled={isPreparing || isExporting}
                      className="w-full rounded-xl border border-[#d9cdd2] p-2.5"
                      id="end-date-input"
                    />
                  </label>
                </div>
              ) : (
                <div className="field-grid">
                  <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="start-month-label">
                    <span>{i18n.t('fromLabel')}</span>
                    <select
                      value={startMonth}
                      onChange={(e) => setStartMonth(e.target.value)}
                      disabled={isPreparing || isExporting}
                      className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
                      id="start-month-select"
                    >
                      {months.map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="end-month-label">
                    <span>{i18n.t('toLabel')}</span>
                    <select
                      value={endMonth}
                      onChange={(e) => setEndMonth(e.target.value)}
                      disabled={isPreparing || isExporting}
                      className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
                      id="end-month-select"
                    >
                      {months.map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Points summary clause */}
          <div className="p-3 my-2 rounded-xl bg-[#fdf2f6] border border-[#f5d9e5] text-sm text-[#6e173d] font-medium" id="points-summary-box">
            {pointsSummary}
          </div>

          {/* Video Title & Duration */}
          <div className="grid gap-3 mt-3">
            <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="video-title-label">
              <span>{i18n.t('videoTitleLabel')}</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isPreparing || isExporting}
                className="w-full rounded-xl border border-[#d9cdd2] p-2.5"
                id="video-title-input"
              />
            </label>

            <div className="field-grid">
              <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="duration-label">
                <span>{i18n.t('durationLabel')}</span>
                <select
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  disabled={isPreparing || isExporting}
                  className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
                  id="duration-select"
                >
                  {DURATION_OPTIONS.map((sec) => (
                    <option key={sec} value={sec}>
                      {i18n.t('durationSeconds', { count: sec })}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="camera-movement-label">
                <span>{i18n.t('cameraMovementLabel')}</span>
                <select
                  value={cameraMovement}
                  onChange={(e) => setCameraMovement(e.target.value as CameraMovement)}
                  disabled={isPreparing || isExporting}
                  className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
                  id="camera-movement-select"
                >
                  <option value="fixed">{i18n.t('cameraFixed')}</option>
                  <option value="steady">{i18n.t('cameraSteady')}</option>
                  <option value="dynamic">{i18n.t('cameraDynamic')}</option>
                  <option value="close-up">{i18n.t('cameraCloseUp')}</option>
                </select>
              </label>
            </div>

            <div className="field-grid">
              <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="video-format-label">
                <span>{i18n.t('videoFormatLabel')}</span>
                <select
                  value={formatKey}
                  onChange={(e) => setFormatKey(e.target.value)}
                  disabled={isPreparing || isExporting}
                  className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
                  id="video-format-select"
                >
                  <option value="standard">{i18n.t('formatSquare480')}</option>
                  <option value="high">{i18n.t('formatSquare720')}</option>
                  <option value="ultra">{i18n.t('formatSquare1080')}</option>
                  <option value="portrait">{i18n.t('formatPortrait')}</option>
                  <option value="landscape">{i18n.t('formatLandscape')}</option>
                </select>
              </label>

              <label className="grid gap-1 font-bold text-sm text-[#493a40]" id="frame-rate-label">
                <span>{i18n.t('frameRateLabel')}</span>
                <select
                  value={frameRateVal}
                  onChange={(e) => {
                    const val = e.target.value;
                    setFrameRateVal(val === 'recommended' ? 'recommended' : (Number(val) as VideoFrameRate));
                  }}
                  disabled={isPreparing || isExporting}
                  className="w-full rounded-xl border border-[#d9cdd2] p-2.5 text-base bg-white"
                  id="frame-rate-select"
                >
                  <option value="recommended">
                    {i18n.t('frameRateRecommended', {
                      fps: (videoFormatByKey(formatKey) ?? VIDEO_FORMATS[0]).frameRate,
                    })}
                  </option>
                  {VIDEO_FRAME_RATES.map((fps) => (
                    <option key={fps} value={fps}>
                      {i18n.t('frameRateValue', { fps })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {/* Privacy Notice and Map Consent */}
          <div className="privacy-notice mt-4" id="privacy-notice-box">
            <strong id="privacy-notice-title">{i18n.t('privacyNoticeTitle')}</strong>
            <p id="privacy-notice-body">{i18n.t('privacyNoticeBody')}</p>
            <label className="checkbox-row" id="map-consent-label">
              <input
                type="checkbox"
                checked={mapConsent}
                onChange={(e) => {
                  setMapConsent(e.target.checked);
                  setSettingsError('');
                }}
                className="w-5 h-5 accent-[#e90064]"
                id="map-consent-checkbox"
              />
              <span>{i18n.t('mapConsentLabel')}</span>
            </label>
          </div>

          {settingsError && <p className="error" id="settings-error-text">{settingsError}</p>}

          {/* Action Buttons */}
          <div className="actions mt-4">
            <button
              type="button"
              onClick={handlePreview}
              disabled={isPreparing || isExporting}
              className="secondary font-bold"
              id="preview-btn"
            >
              {i18n.t('previewButton')}
            </button>
            <button
              type="button"
              onClick={handleCreateMp4}
              disabled={isPreparing || isExporting || !hasVideoEncoder()}
              className="font-bold"
              id="create-mp4-btn"
            >
              {i18n.t('createButton')}
            </button>
          </div>

          {(isPreparing || isExporting) && (
            <button
              type="button"
              onClick={handleCancelOperation}
              className="cancel-button secondary font-bold mt-2"
              id="cancel-operation-btn"
            >
              {i18n.t('cancelButton')}
            </button>
          )}
        </section>
      )}

      {/* Preview / Output Card */}
      {(preparedJourney !== null || isPreparing || isExporting || progressMsg !== '') && (
        <section className="card" id="preview-card">
          <div className="section-heading mb-3">
            <h2 id="preview-heading">{i18n.t('previewTitle')}</h2>
            <span id="preview-status-text">{progressMsg}</span>
          </div>

          {progressFraction !== null && (
            <progress value={progressFraction} max={1} className="w-full mb-3" id="operation-progress-bar" />
          )}

          {/* Canvas preview element */}
          <canvas
            ref={canvasRef}
            className="w-full bg-[#f2edf0] rounded-2xl aspect-square object-contain mx-auto"
            style={{
              aspectRatio: `${activeVideoFormat.width} / ${activeVideoFormat.height}`,
            }}
            id="preview-canvas"
          />

          {preparedJourney && !isPreparing && !isExporting && (
            <div className="flex items-center justify-between gap-3 mt-3">
              <button
                type="button"
                onClick={() => {
                  if (isPlaying) {
                    stopAnimation();
                  } else {
                    const startAt = playbackProgress >= 1 ? 0 : playbackProgress;
                    startAnimation(preparedJourney, startAt);
                  }
                }}
                className="secondary flex-1 font-bold"
                id="play-pause-btn"
              >
                {isPlaying ? '⏸ Pause' : playbackProgress >= 1 ? '🔄 Replay' : '▶ Play'}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={playbackProgress}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  stopAnimation();
                  setPlaybackProgress(val);
                  renderFrameOnCanvas(preparedJourney, val);
                }}
                className="flex-2 accent-[#e90064] cursor-pointer"
                id="playback-scrubber"
              />
            </div>
          )}

          {/* Video Result if MP4 export completed */}
          {videoBlobUrl && (
            <div className="mt-4 pt-4 border-t border-[#ecd2dd]" id="export-result-box">
              <video
                controls
                autoPlay
                loop
                src={videoBlobUrl}
                className="w-full rounded-2xl bg-black aspect-square object-contain"
                style={{
                  aspectRatio: `${activeVideoFormat.width} / ${activeVideoFormat.height}`,
                }}
                id="exported-video-player"
              />
              <div className="actions mt-3">
                <button
                  type="button"
                  onClick={handleShareVideo}
                  className="secondary font-bold"
                  id="share-video-btn"
                >
                  {i18n.t('shareButton')}
                </button>
                <button
                  type="button"
                  onClick={handleDownloadVideo}
                  className="font-bold"
                  id="download-video-btn"
                >
                  {i18n.t('downloadButton')}
                </button>
              </div>
            </div>
          )}

          {errorMessage && <p className="error mt-3" id="preview-error-text">{errorMessage}</p>}
        </section>
      )}

      {/* Footer */}
      <footer className="mt-8 text-center text-xs text-[#7b6570] space-y-1">
        <p>{i18n.t('footerNoAccount')}</p>
        <p>{i18n.t('footerMapAttribution')}</p>
      </footer>
    </main>
  );
}
