import type { Language, OptionsPrediction } from '../domain/types.js';
import { calculateThaiGoldPrice } from '../domain/thai-gold.js';
import { t } from '../i18n.js';

interface PredictionPanelProps {
  prediction: OptionsPrediction;
  language: Language;
  unit: 'usd' | 'thb';
  usdThb?: number | null;
}

function formatExposure(value: number) {
  const absolute = Math.abs(value);
  const suffix = absolute >= 1_000_000_000 ? 'B' : absolute >= 1_000_000 ? 'M' : absolute >= 1_000 ? 'K' : '';
  const divisor = suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
  return `${value < 0 ? '-' : ''}${(absolute / divisor).toFixed(absolute >= 1_000 ? 1 : 0)}${suffix}`;
}

function formatPercent(value: number) {
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`;
}

function formatPrice(value: number | null, language: Language, unit: PredictionPanelProps['unit'], usdThb?: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const converted = unit === 'thb' && Number.isFinite(usdThb) ? calculateThaiGoldPrice(value, usdThb as number) : value;
  const formatted = new Intl.NumberFormat(language === 'th' ? 'th-TH' : 'en-US', { maximumFractionDigits: unit === 'thb' ? 0 : 0 }).format(converted);
  return unit === 'thb' ? `฿${formatted}` : `$${formatted}`;
}

function scenarioLabel(label: string, language: Language) {
  if (language !== 'th') return label;
  const translations: Record<string, string> = {
    'Upside options pressure': 'แรงหนุนจากออปชันฝั่งขึ้น',
    'Downside options pressure': 'แรงกดดันจากออปชันฝั่งลง',
    'Balanced options pressure': 'แรงจากออปชันสมดุล',
  };
  return translations[label] ?? label;
}

function regimeLabel(regime: OptionsPrediction['gamma']['regime'], language: Language) {
  if (language !== 'th') return regime;
  return regime === 'positive' ? 'เป็นบวก' : regime === 'negative' ? 'เป็นลบ' : 'เป็นกลาง';
}

export default function PredictionPanel({ prediction, language, unit, usdThb }: PredictionPanelProps) {
  const price = (value: number | null) => formatPrice(value, language, unit, usdThb);
  const isThai = unit === 'thb';
  return (
    <section className="prediction-panel" aria-label={t(language, 'predictionDiagnostics')}>
      <div className="prediction-panel-header">
        <div>
          <span className="control-label">{t(language, 'predictionInputs')}</span>
          <h2>{t(language, 'predictionDiagnostics')}</h2>
          <p>{t(language, 'predictionDescription')}</p>
        </div>
        <span className="prediction-asof">{t(language, 'oiAsOf')} {prediction.quality.latestOiDate ?? prediction.asOfDate}</span>
      </div>
      <div className="prediction-grid">
        <div className="prediction-card"><span>{t(language, 'scenario')}</span><strong>{scenarioLabel(prediction.scenario.label, language)}</strong><small>{t(language, 'score')} {formatPercent(prediction.scenario.score)} · {t(language, 'weight')} {(prediction.scenario.weight * 100).toFixed(0)}%</small></div>
        <div className="prediction-card"><span>{t(language, 'compositePain')}</span><strong>{price(prediction.maxPain.compositeStrike)}</strong><small>{t(language, 'nearestPain')} {price(prediction.maxPain.nearestStrike)}</small></div>
        <div className="prediction-card"><span>{t(language, 'gamma')}</span><strong>{regimeLabel(prediction.gamma.regime, language)}</strong><small>{t(language, 'net')} {formatExposure(prediction.gamma.netExposure)} · {t(language, 'flip')} {price(prediction.gamma.flipStrike)}</small></div>
        <div className="prediction-card"><span>{t(language, 'vanna')}</span><strong>{formatExposure(prediction.vanna.netExposure)}</strong><small>{t(language, 'call')} {formatExposure(prediction.vanna.callExposure)} · {t(language, 'put')} {formatExposure(prediction.vanna.putExposure)}</small></div>
        <div className="prediction-card"><span>{t(language, 'targetGuide')}</span><strong>{price(prediction.scenario.targetPrice)}</strong><small>{t(language, 'heuristicOnly')}</small></div>
        <div className="prediction-card"><span>{t(language, 'observedIv')}</span><strong>{(prediction.quality.observedVolCoverage * 100).toFixed(0)}%</strong><small>{prediction.quality.activeExpiryCount} {t(language, 'activeExpiries')} · {prediction.quality.strikeCount.toLocaleString()} {t(language, 'oiRows')}</small></div>
      </div>
      {isThai ? <p className="prediction-unit-note">{t(language, 'thaiPredictionNote')} · USD/THB {usdThb?.toFixed(2) ?? '—'}</p> : null}
      {prediction.quality.warnings.length > 0 ? <p className="prediction-warning">{prediction.quality.warnings.join(' · ')}</p> : null}
    </section>
  );
}
