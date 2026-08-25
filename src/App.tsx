// @ts-nocheck
import { useState, useRef, useEffect, ChangeEvent, useMemo } from 'react';
import { parseTimelineJson, parseRawSignalsJson, processRawSignals, availableMonths, pointDateKey, localDateKey, TimelineParseError } from './timeline';
import type { GeoPoint, MonthOption, CameraMovement, PreparedJourney, TimelineFrame } from './types';
import { filterLocationOutliers } from './outlier';
import { selectTimelineModePoints } from './selection';
import { prepareJourney, drawFrame, previewCanvasSize } from './renderer';
import { totalDurationSeconds, frameAtElapsedSeconds } from './animation';
import { createJourneyMp4, hasVideoEncoder, VIDEO_FORMATS, VIDEO_FRAME_RATES, videoFormatAtFrameRate, videoFormatByKey } from './video';
import type { VideoFormat, VideoFormatSupport } from './video';
import { readLanguagePreference, writeLanguagePreference, activeLocale, createI18n, formattingLocale, type LanguagePreference } from './i18n';
import { readDistanceUnitPreference, writeDistanceUnitPreference, resolveDistanceUnit, type DistanceUnitPreference, type DistanceUnit } from './distance-unit';

function browserLanguages(): readonly string[] {
  return navigator.languages ?? [navigator.language];
}

function buildI18n(preference: LanguagePreference) {
  const tags = browserLanguages();
  const locale = activeLocale(preference, tags);
  return createI18n(locale, formattingLocale(preference, tags, locale));
}

export default function App() {
  const [langPref, setLangPref] = useState<LanguagePreference>(() => readLanguagePreference());
  const i18n = useMemo(() => buildI18n(langPref), [langPref]);

  const [distPref, setDistPref] = useState<DistanceUnitPreference>(() => readDistanceUnitPreference());
  const distanceUnit = resolveDistanceUnit(distPref, browserLanguages());

  const [fileStatus, setFileStatus] = useState<string>(i18n.t('fileStatusEmpty'));
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [settingsError, setSettingsError] = useState<string>('');

  const [allPoints, setAllPoints] = useState<GeoPoint[]>([]);
  const [semanticPoints, setSemanticPoints] = useState<GeoPoint[]>([]);
  const [filteredPoints, setFilteredPoints] = useState<GeoPoint[]>([]);
  const [rawSignalPoints, setRawSignalPoints] = useState<any[]>([]);
  const [rawProcessing, setRawProcessing] = useState<any>(null);
  const [months, setMonths] = useState<MonthOption[]>([]);

  const [useRaw, setUseRaw] = useState(false);
  const [rawLimit, setRawLimit] = useState(100);
  const [filterMode, setFilterMode] = useState<'conservative'|'off'>('conservative');
  const [exactDates, setExactDates] = useState(false);
  
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  
  const [title, setTitle] = useState(i18n.t('defaultVideoTitle'));
  const [duration, setDuration] = useState(10);
  const [cameraMovement, setCameraMovement] = useState<CameraMovement>('steady');
  const [formatKey, setFormatKey] = useState('standard');
  const [frameRateVal, setFrameRateVal] = useState<'recommended'|string>('recommended');
  
  const [mapConsent, setMapConsent] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const [previewActive, setPreviewActive] = useState(false);
  const [progressMsg, setProgressMsg] = useState(i18n.t('progressReady'));
  const [progressValue, setProgressValue] = useState(0);
  
  const [resultUrl, setResultUrl] = useState<string|null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    writeLanguagePreference(langPref);
  }, [langPref]);

  useEffect(() => {
    writeDistanceUnitPreference(distPref);
  }, [distPref]);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setFileStatus(i18n.t('fileStatusReading', { name: file.name }));
      const text = await file.text();
      const data = JSON.parse(text);
      
      const rawPoints = parseRawSignalsJson(data);
      const rawProc = processRawSignals(rawPoints, rawLimit);
      const semPoints = parseTimelineJson(data);
      const filtPoints = filterLocationOutliers(semPoints, filterMode).points;

      setRawSignalPoints(rawPoints);
      setRawProcessing(rawProc);
      setSemanticPoints(semPoints);
      setFilteredPoints(filtPoints);

      const pts = semPoints;
      if (pts.length === 0) {
        throw new TimelineParseError('no-usable-locations', 'No locations');
      }
      setAllPoints(pts);

      const m = availableMonths(pts, i18n.formatLocale);
      setMonths(m);
      setStartMonth(m[0]?.key || '');
      setEndMonth(m[m.length - 1]?.key || m[0]?.key || '');

      const dateKeys = pts.map(pointDateKey).sort();
      const firstD = dateKeys[0] || localDateKey(pts[0].instant);
      const lastD = dateKeys[dateKeys.length - 1] || firstD;
      setStartDate(firstD);
      setEndDate(lastD);

      setFileStatus(i18n.t('fileStatusLoaded', { count: pts.length, source: file.name, firstMonth: m[0]?.key, lastMonth: m[m.length-1]?.key }));
    } catch (err: any) {
      setFileStatus(i18n.t('fileStatusLoadFailed'));
      setErrorMsg(err.message || 'Error');
    }
  };

  const handlePreview = async () => {
    if (!mapConsent) {
      setSettingsError(i18n.t('errorMapConsent'));
      return;
    }
    setPreviewActive(true);
    setIsPreparing(true);
    // TODO full implementation
    setIsPreparing(false);
  };

  return (
    <main className="shell">
      <header className="app-header">
        <h1>{i18n.t('headerTitle')}</h1>
      </header>

      <section className="card intro">
        <h2>{i18n.t('fileCardTitle')}</h2>
        <p>{i18n.t('fileCardIntro')}</p>
        <div className="source-actions mt-4">
          <label className="file-button cursor-pointer inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-pink-600 px-4 py-2 font-bold text-white text-center">
            <span>{i18n.t('chooseFileButton')}</span>
            <input type="file" accept=".json" onChange={handleFile} className="hidden" />
          </label>
        </div>
        <p className="status mt-3 text-sm">{fileStatus}</p>

        <label className="mt-4 grid gap-2 font-bold text-[#493a40]">
          <span>{i18n.t('languageLabel')}</span>
          <select value={langPref} onChange={e => setLangPref(e.target.value as LanguagePreference)} className="w-full rounded-xl border border-[#d9cdd2] p-3 text-base">
            <option value="system">{i18n.t('languageSystemDefault')}</option>
            <option value="en">English</option>
            <option value="ko">한국어</option>
            <option value="ja">日本語</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
          </select>
        </label>
      </section>

      {allPoints.length > 0 && (
        <section className="card">
          <h2>{i18n.t('settingsTitle')}</h2>
          <div className="grid gap-4">
            <label className="flex items-center gap-2 cursor-pointer font-bold">
              <input type="checkbox" checked={exactDates} onChange={e => setExactDates(e.target.checked)} className="w-5 h-5 accent-pink-600" />
              <span>{i18n.t('exactDatesToggle')}</span>
            </label>
            
            {exactDates ? (
               <div className="grid grid-cols-2 gap-4">
                 <label className="grid gap-2 font-bold text-[#493a40]">
                   <span>{i18n.t('startDateLabel')}</span>
                   <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full rounded-xl border border-[#d9cdd2] p-3" />
                 </label>
                 <label className="grid gap-2 font-bold text-[#493a40]">
                   <span>{i18n.t('endDateLabel')}</span>
                   <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full rounded-xl border border-[#d9cdd2] p-3" />
                 </label>
               </div>
            ) : (
               <div className="grid grid-cols-2 gap-4">
                 <label className="grid gap-2 font-bold text-[#493a40]">
                   <span>{i18n.t('fromLabel')}</span>
                   <select value={startMonth} onChange={e => setStartMonth(e.target.value)} className="w-full rounded-xl border border-[#d9cdd2] p-3">
                     {months.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                   </select>
                 </label>
                 <label className="grid gap-2 font-bold text-[#493a40]">
                   <span>{i18n.t('toLabel')}</span>
                   <select value={endMonth} onChange={e => setEndMonth(e.target.value)} className="w-full rounded-xl border border-[#d9cdd2] p-3">
                     {months.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                   </select>
                 </label>
               </div>
            )}

            <label className="grid gap-2 font-bold text-[#493a40]">
              <span>{i18n.t('videoTitleLabel')}</span>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)} className="w-full rounded-xl border border-[#d9cdd2] p-3" />
            </label>

            <div className="mt-4 rounded-xl border border-[#ecd2dd] bg-[#fff8fb] p-4">
              <strong className="block mb-2 text-sm">{i18n.t('privacyNoticeTitle')}</strong>
              <p className="text-sm mb-2">{i18n.t('privacyNoticeBody')}</p>
              <label className="flex items-center gap-2 cursor-pointer font-bold mt-2">
                <input type="checkbox" checked={mapConsent} onChange={e => { setMapConsent(e.target.checked); setSettingsError(''); }} className="w-5 h-5 accent-pink-600" />
                <span className="text-sm">{i18n.t('mapConsentLabel')}</span>
              </label>
            </div>

            {settingsError && <p className="text-[#a4002f] font-bold mt-2">{settingsError}</p>}
            
            <div className="grid grid-cols-2 gap-4 mt-4">
              <button onClick={handlePreview} className="rounded-xl bg-[#f9dbe8] text-[#5c1840] font-bold p-3" disabled={isPreparing || isExporting}>
                {i18n.t('previewButton')}
              </button>
              <button className="rounded-xl bg-pink-600 text-white font-bold p-3 disabled:opacity-50" disabled={isPreparing || isExporting}>
                {i18n.t('createButton')}
              </button>
            </div>
          </div>
        </section>
      )}

      {previewActive && (
        <section className="card">
          <div className="flex items-baseline justify-between mb-4">
            <h2>{i18n.t('previewTitle')}</h2>
            <span className="text-sm text-[#7b6570]">{progressMsg}</span>
          </div>
          <canvas ref={canvasRef} className="w-full rounded-2xl bg-[#f2edf0] aspect-square object-contain" />
          {errorMsg && <p className="text-[#a4002f] font-bold mt-3">{errorMsg}</p>}
        </section>
      )}
    </main>
  );
}
