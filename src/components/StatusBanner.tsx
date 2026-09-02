import type { DashboardHealth, DashboardMode, Language } from '../domain/types';
import { t } from '../i18n';

interface StatusBannerProps {
  health: DashboardHealth;
  language: Language;
  mode: DashboardMode;
  onViewStatus?: () => void;
}

function formatPriceMessage(message: string | null, language: Language) {
  if (!message || language === 'en') return message;
  const match = message.match(/^Latest closed price bars · 1D (.+?) · 4H (.+?) · (fresh|stale by age)$/);
  if (!match) return message;
  return `แท่งราคาปิดล่าสุด · 1D ${match[1]} · 4H ${match[2]} · ${match[3] === 'fresh' ? 'ข้อมูลใหม่' : 'ข้อมูลล่าช้า'}`;
}

function formatOiMessage(message: string | null, language: Language) {
  if (!message || language === 'en') return message;
  const match = message.match(/^(\d+) front-equivalent snapshots; (\d+) all-expiry snapshots; OI as-of ([^ ]+) \((\d+) business-day lag\); expiry ([^ ]+) → ([^ ]+)$/);
  if (!match) return message;
  return `OI ข้อมูล ณ วันที่ ${match[3]} · สัญญาหมดอายุ (Expiry) ${match[5]} → ${match[6]} · รวม ${match[1]} ชุด Front / ${match[2]} ชุด All-expiry`;
}

function formatAuthMessage(state: DashboardHealth['auth']['state'], message: string | null, language: Language) {
  if (language === 'en') return message;
  if (state === 'ok') return 'CME session ยืนยันแล้ว';
  if (state === 'challenge') return 'CME ต้องทำ MFA/CAPTCHA บน self-hosted runner';
  if (state === 'reauth_required') return 'CME session หมดอายุ ต้องเข้าสู่ระบบใหม่';
  if (state === 'failed') return 'CME ยืนยันตัวตนไม่สำเร็จ';
  return message ?? 'ยังไม่ได้ตรวจสอบ CME session';
}

export default function StatusBanner({ health, language, mode, onViewStatus }: StatusBannerProps) {
  const thaiMode = mode !== 'futures';
  const thaiState = health.thaiGold?.state ?? 'error';
  const modeState = thaiMode
    ? thaiState === 'ok' ? 'ok' : thaiState === 'stale' ? 'stale' : 'error'
    : health.state;
  const authMessage = formatAuthMessage(health.auth.state, health.auth.message, language);

  const modeMessages = thaiMode
    ? [thaiState === 'ok' ? t(language, 'thaiGoldReady') : health.thaiGold?.message ?? t(language, 'noThaiData')]
    : [formatPriceMessage(health.price.message, language), formatOiMessage(health.oi.message, language), authMessage];
  const messages = modeMessages
    .filter((message, index, values): message is string => Boolean(message) && values.indexOf(message) === index);
  const stateLabel = modeState === 'ok'
    ? `${language === 'th' ? 'ล่าสุด' : 'LIVE'} / ${t(language, 'fresh')}`
    : modeState === 'partial'
      ? language === 'th' ? 'บางส่วน' : 'PARTIAL'
      : modeState === 'stale'
        ? t(language, 'stale').toUpperCase()
        : language === 'th' ? 'ผิดพลาด' : 'ERROR';

  return (
    <div
      className={`status-banner status-${modeState} ${onViewStatus ? 'status-clickable' : ''}`}
      role="status"
      onClick={onViewStatus}
      title={onViewStatus ? (language === 'th' ? 'คลิกเพื่อเปิดดูหน้ารายละเอียดสถานะข้อมูล' : 'Click to view detailed data status') : undefined}
    >
      <span className="status-dot" />
      <strong>{stateLabel}</strong>
      <span>{messages.length > 0 ? messages.join(' · ') : `ข้อมูลล่าสุด ${health.lastSuccessAt ?? 'ไม่ทราบเวลา'}`}</span>
      {!thaiMode && health.price.state === 'stale' && <span className="status-chip">{language === 'th' ? 'ราคาล่าช้า' : 'PRICE STALE'}</span>}
      {!thaiMode && health.oi.state === 'stale' && <span className="status-chip">{language === 'th' ? 'OI ล่าช้า' : 'OI STALE'}</span>}
      {thaiMode && health.thaiGold?.state === 'stale' && <span className="status-chip">{language === 'th' ? 'ทองไทยล่าช้า' : 'THAI GOLD STALE'}</span>}
      {!thaiMode && health.auth.state === 'challenge' && <span className="status-chip">{language === 'th' ? 'ต้องยืนยันตัวตน' : 'AUTH CHALLENGE'}</span>}
      {!thaiMode && health.auth.state === 'reauth_required' && <span className="status-chip">{language === 'th' ? 'ต้องเข้าสู่ระบบ CME ใหม่' : 'CME REAUTH REQUIRED'}</span>}
      {!thaiMode && health.auth.state === 'failed' && <span className="status-chip">{language === 'th' ? 'CME ยืนยันตัวตนไม่ผ่าน' : 'CME AUTH FAILED'}</span>}
      {onViewStatus && <span className="status-action-link">{language === 'th' ? 'ดูสถานะละเอียด →' : 'Details →'}</span>}
    </div>
  );
}
