import { useMemo } from 'react';
import type { ContractExpirySeries, DashboardHealth, DataManifest, Language, PriceBar, ThaiGoldData, WallSegment } from '../domain/types';
import { isExpiryDateExpired } from '../domain/wall-status';

interface DataStatusPanelProps {
  manifest: DataManifest | null;
  health: DashboardHealth;
  expirySeries: ContractExpirySeries | null;
  walls: WallSegment[];
  price: PriceBar[];
  thaiGold: ThaiGoldData | null;
  language: Language;
  displayTimezone: string;
}

interface ContractStatusRow {
  code: string;
  label: string;
  groupLabel: string;
  expiryDate: string;
  daysRemaining: number;
  category: 'front' | 'mid' | 'far';
  expired: boolean;
  wallCount: number;
}

function formatDate(value: string, timezone: string, language: Language) {
  return new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(new Date(value));
}

function calculateDte(expiryDate: string, nowMs = Date.now()): number {
  const expiryMs = Date.parse(`${expiryDate}T22:00:00Z`);
  if (!Number.isFinite(expiryMs)) return 0;
  return Math.round((expiryMs - nowMs) / (1000 * 60 * 60 * 24));
}

export default function DataStatusPanel({
  manifest,
  health,
  expirySeries,
  walls,
  thaiGold,
  language,
  displayTimezone,
}: DataStatusPanelProps) {
  const isTh = language === 'th';
  const now = Date.now();

  const contractRows = useMemo<ContractStatusRow[]>(() => {
    const wallCountByExpiry = new Map<string, number>();
    for (const wall of walls) {
      for (const expiry of wall.expiryDates) {
        wallCountByExpiry.set(expiry, (wallCountByExpiry.get(expiry) ?? 0) + 1);
      }
    }

    return (expirySeries?.expiries ?? []).map((item) => {
      const dte = calculateDte(item.expiryDate, now);
      const expired = isExpiryDateExpired(item.expiryDate, now);
      let category: 'front' | 'mid' | 'far' = 'far';
      if (dte >= 0 && dte <= 90) category = 'front';
      else if (dte > 90 && dte <= 365) category = 'mid';

      return {
        code: item.code,
        label: item.label,
        groupLabel: item.groupLabel,
        expiryDate: item.expiryDate,
        daysRemaining: dte,
        category,
        expired,
        wallCount: wallCountByExpiry.get(item.expiryDate) ?? 0,
      };
    }).sort((a, b) => Number(a.expired) - Number(b.expired) || a.expiryDate.localeCompare(b.expiryDate));
  }, [expirySeries, now, walls]);

  const frontContracts = contractRows.filter((row) => !row.expired && row.category === 'front');
  const midContracts = contractRows.filter((row) => !row.expired && row.category === 'mid');
  const farContracts = contractRows.filter((row) => !row.expired && row.category === 'far');
  const nearestContract = frontContracts[0] ?? contractRows.find((row) => !row.expired) ?? null;

  const price1dEnd = manifest?.datasets.price_1d?.coverageEnd ?? manifest?.coverage.price.end?.slice(0, 10) ?? '—';
  const price4hEnd = manifest?.datasets.price_4h?.coverageEnd ?? manifest?.coverage.price.end?.slice(0, 10) ?? '—';
  const oiStart = manifest?.coverage.oi?.start ?? '2026-07-14';
  const oiEnd = manifest?.coverage.oi?.end ?? '2026-09-02';
  const expiryStart = manifest?.coverage.oiExpiry?.start ?? '2026-09-24';
  const expiryEnd = manifest?.coverage.oiExpiry?.end ?? '2032-05-25';

  return (
    <section className="details-panel status-details-panel" aria-label="Data & System Status">
      <div className="details-header">
        <div>
          <span className="control-label">{isTh ? 'ศูนย์ข้อมูลและสถานะ' : 'Data & Pipeline Health'}</span>
          <h2>{isTh ? 'สถานะข้อมูลและวันหมดอายุสัญญา' : 'Data Status & Contract Expiry Overview'}</h2>
          <p>
            {isTh
              ? 'สรุปวันที่ครอบคลุมของราคา GC, ข้อมูล Open Interest (OI), รายการสัญญาที่กำลังใช้งาน และกำหนดวันหมดอายุ'
              : 'Summary of GC price coverage, Open Interest observation window, active CME contracts, and expiry schedule'}
          </p>
        </div>
        <div className="details-summary">
          <div>
            <strong>{oiEnd}</strong>
            <small>{isTh ? 'ข้อมูล OI ล่าสุด' : 'Latest OI As-Of'}</small>
          </div>
          <div>
            <strong>{nearestContract?.expiryDate ?? '—'}</strong>
            <small>{isTh ? 'สัญญาใกล้สุดหมด' : 'Nearest Expiry'}</small>
          </div>
          <div>
            <strong>{frontContracts.length}</strong>
            <small>{isTh ? 'สัญญาสั้น (Front)' : 'Front Contracts'}</small>
          </div>
          <div>
            <strong>{contractRows.filter((r) => !r.expired).length}</strong>
            <small>{isTh ? 'สัญญาทั้งหมด' : 'Total Active Series'}</small>
          </div>
        </div>
      </div>

      <div className="status-cards-grid">
        <div className="status-info-card">
          <div className="card-top">
            <span className="card-badge badge-price">📈 {isTh ? 'ราคาทองโลก (GC)' : 'GC Futures Price'}</span>
            <span className={`status-pill ${health.price.state === 'ok' ? 'pill-ok' : 'pill-warn'}`}>
              {health.price.state === 'ok' ? (isTh ? 'สดใหม่ (Fresh)' : 'Fresh') : (isTh ? 'ล่าช้า' : 'Stale')}
            </span>
          </div>
          <div className="card-body">
            <div className="metric-row">
              <span>{isTh ? 'แท่งราคา 1D' : '1D Daily Bars'}:</span>
              <strong>{price1dEnd}</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'แท่งราคา 4H' : '4H Intraday Bars'}:</span>
              <strong>{price4hEnd}</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'แหล่งข้อมูล' : 'Source'}:</span>
              <small>TradingView (BLACKBULL:GOLD.F)</small>
            </div>
          </div>
          <div className="card-footer">
            <small>{isTh ? 'ความถี่: อัปเดตทุก 15 นาที ในวันทำการ' : 'Frequency: Refreshes every 15m on weekdays'}</small>
          </div>
        </div>

        <div className="status-info-card">
          <div className="card-top">
            <span className="card-badge badge-oi">🧱 {isTh ? 'ข้อมูล Open Interest (OI)' : 'Open Interest (OI)'}</span>
            <span className={`status-pill ${manifest?.coverage.oi?.end ? 'pill-ok' : 'pill-warn'}`}>
              {isTh ? 'อัปเดตแล้ว' : 'Updated'}
            </span>
          </div>
          <div className="card-body">
            <div className="metric-row">
              <span>{isTh ? 'ช่วงประวัติ OI ที่มี' : 'OI Data Window'}:</span>
              <strong className="text-highlight">{oiStart} → {oiEnd}</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'วันที่มีข้อมูลล่าสุด' : 'Latest Data As-Of'}:</span>
              <strong>{oiEnd}</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'Snapshots' : 'Snapshots'}:</span>
              <small>{manifest?.datasets.oi_front?.rowCount ?? 0} front / {manifest?.datasets.oi_all_expiries?.rowCount ?? 0} all-expiry</small>
            </div>
          </div>
          <div className="card-footer">
            <small>{isTh ? 'รอบการเก็บ: วันละ 3 รอบ (Open, Mid, Close)' : 'Collected: 3 sessions daily (Open/Mid/Close)'}</small>
          </div>
        </div>

        <div className="status-info-card">
          <div className="card-top">
            <span className="card-badge badge-expiry">⏳ {isTh ? 'วันหมดอายุสัญญา (Expiry)' : 'Contract Expiry Range'}</span>
            <span className="status-pill pill-ok">
              {contractRows.filter((r) => !r.expired).length} {isTh ? 'ซีรีส์' : 'Series'}
            </span>
          </div>
          <div className="card-body">
            <div className="metric-row">
              <span>{isTh ? 'สัญญาสั้นใกล้สุด' : 'Nearest Front'}:</span>
              <strong className="text-front">{nearestContract?.code ?? 'Oct 2026'} ({nearestContract?.expiryDate})</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'นับถอยหลัง' : 'Days Remaining'}:</span>
              <strong className="text-warn">{nearestContract ? `${nearestContract.daysRemaining} ${isTh ? 'วัน' : 'days'}` : '—'}</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'ช่วงสัญญาทั้งหมด' : 'Expiry Coverage'}:</span>
              <small>{expiryStart} → {expiryEnd}</small>
            </div>
          </div>
          <div className="card-footer">
            <small>{isTh ? 'สัญญาใกล้สุด: มีผลต่อแนวรับแนวต้าน OI Wall มากที่สุด' : 'Front contracts anchor the primary OI Walls'}</small>
          </div>
        </div>

        <div className="status-info-card">
          <div className="card-top">
            <span className="card-badge badge-thai">🇹🇭 {isTh ? 'ราคาทองคำไทย (GTA)' : 'Thai Gold GTA'}</span>
            <span className={`status-pill ${health.thaiGold?.state === 'ok' ? 'pill-ok' : 'pill-warn'}`}>
              {health.thaiGold?.state === 'ok' ? (isTh ? 'พร้อมใช้งาน' : 'Ready') : (isTh ? 'ใช้แคชเดิม' : 'Cached')}
            </span>
          </div>
          <div className="card-body">
            <div className="metric-row">
              <span>{isTh ? 'ข้อมูลทองไทย ณ' : 'Thai Gold As-Of'}:</span>
              <strong>{thaiGold?.points.at(-1)?.asOf ? formatDate(thaiGold.points.at(-1)!.asOf, displayTimezone, language) : '—'}</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'ราคาขายออก' : 'Sell Price'}:</span>
              <strong className="text-gold">{thaiGold?.points.at(-1)?.actualSell ? `฿${thaiGold.points.at(-1)!.actualSell.toLocaleString()}` : '—'}</strong>
            </div>
            <div className="metric-row">
              <span>{isTh ? 'CME Session' : 'CME Session'}:</span>
              <small className="text-cme">{health.auth.state === 'ok' ? (isTh ? 'ยืนยันแล้ว (Session OK)' : 'Verified') : health.auth.message ?? 'Unknown'}</small>
            </div>
          </div>
          <div className="card-footer">
            <small>{isTh ? 'แหล่งข้อมูล: สมาคมค้าทองคำ goldtraders.or.th' : 'Source: Gold Traders Association'}</small>
          </div>
        </div>
      </div>

      <div className="details-section">
        <div className="details-section-header">
          <div>
            <strong>{isTh ? 'ตารางสัญญา CME Gold และกำหนดวันหมดอายุ' : 'CME Gold Options & Futures Expiry Schedule'}</strong>
            <small>
              {isTh
                ? 'เรียงจากสัญญาระยะสั้นใกล้สุด (Front-Month) ไปหาสัญญาระยะยาว (Far-Dated)'
                : 'Ordered from nearest front-month to far-dated maturities'}
            </small>
          </div>
          <span className="details-count">
            {frontContracts.length} {isTh ? 'สัญญาสั้น (Front)' : 'Front'} · {midContracts.length} {isTh ? 'สัญญากลาง' : 'Mid'} · {farContracts.length} {isTh ? 'สัญญายาว' : 'Far'}
          </span>
        </div>

        <div className="details-table-wrap">
          <table className="details-table status-contracts-table">
            <thead>
              <tr>
                <th>{isTh ? 'รหัสสัญญา / ซีรีส์' : 'Contract Series'}</th>
                <th>{isTh ? 'ประเภท' : 'Category'}</th>
                <th>{isTh ? 'วันหมดอายุ (Expiry Date)' : 'Expiry Date'}</th>
                <th>{isTh ? 'เวลาคงเหลือ (DTE)' : 'Days Remaining'}</th>
                <th>{isTh ? 'สถานะ' : 'Status'}</th>
                <th>{isTh ? 'แนว OI Wall' : 'Wall Segments'}</th>
              </tr>
            </thead>
            <tbody>
              {contractRows.map((row) => (
                <tr key={row.expiryDate} className={row.category === 'front' ? 'row-front-contract' : ''}>
                  <td>
                    <strong>GC · {row.label ? row.label : formatDate(row.expiryDate, 'UTC', language)}</strong>
                    <small>{row.code ?? row.expiryDate}</small>
                  </td>
                  <td>
                    <span className={`contract-cat-badge cat-${row.category}`}>
                      {row.category === 'front' ? (isTh ? 'สัญญาสั้น (7-90D)' : 'Front (7-90D)') : row.category === 'mid' ? (isTh ? 'สัญญากลาง (ปี 2027)' : 'Mid (2027)') : (isTh ? 'สัญญายาว (2028-32)' : 'Far (2028-32)')}
                    </span>
                  </td>
                  <td>
                    <strong>{formatDate(row.expiryDate, 'UTC', language)}</strong>
                    <small>({row.expiryDate})</small>
                  </td>
                  <td>
                    {row.expired ? (
                      <span className="dte-badge dte-expired">{isTh ? 'หมดอายุแล้ว' : 'Expired'}</span>
                    ) : (
                      <span className={`dte-badge ${row.daysRemaining <= 30 ? 'dte-urgent' : row.daysRemaining <= 90 ? 'dte-front' : 'dte-normal'}`}>
                        {row.daysRemaining} {isTh ? 'วัน' : 'days'}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`expiry-badge ${row.expired ? 'expired' : 'unexpired'}`}>
                      {row.expired ? (isTh ? 'หมดอายุ' : 'Expired') : (isTh ? 'เปิดใช้งาน' : 'Active')}
                    </span>
                  </td>
                  <td>
                    {row.wallCount > 0 ? (
                      <span className="wall-count-pill">{row.wallCount.toLocaleString()} {isTh ? 'แนว' : 'walls'}</span>
                    ) : (
                      <span className="wall-count-none">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="automation-schedule-box">
        <div className="schedule-header">
          <strong>⚡ {isTh ? 'ตารางการอัปเดตอัตโนมัติบน GitHub Actions' : 'Automated GitHub Actions Schedule'}</strong>
          <small>{isTh ? 'ระบบทำงานตามเวลาตลาด CME สหรัฐฯ และแสดงผลในเวลาไทย' : 'Runs on CME market hours, displayed in Bangkok time'}</small>
        </div>
        <div className="schedule-grid">
          <div className="schedule-item">
            <span className="schedule-tag tag-price">15m Refresh</span>
            <strong>{isTh ? 'ราคาทองโลก (GC)' : 'GC Price Bars'}</strong>
            <small>{isTh ? 'ทุก 15 นาที ในวันทำการ' : 'Every 15 minutes on weekdays'}</small>
          </div>
          <div className="schedule-item">
            <span className="schedule-tag tag-cme">19:30 🇹🇭 (06:30 CME)</span>
            <strong>{isTh ? 'ซีรีส์สัญญา (Expiry Series)' : 'Contract Expiry Inventory'}</strong>
            <small>{isTh ? 'วันละ 1 ครั้ง ตรวจสอบสัญญาใหม่' : 'Daily refresh of CME contract series'}</small>
          </div>
          <div className="schedule-item">
            <span className="schedule-tag tag-oi">20:50, 22:55, 01:20 🇹🇭</span>
            <strong>{isTh ? 'Open Interest & Walls' : 'Live OI & Wall Engine'}</strong>
            <small>{isTh ? 'รอบ Open / Mid / Close ของ CME' : 'CME Open, Mid, and Close sessions'}</small>
          </div>
          <div className="schedule-item">
            <span className="schedule-tag tag-pages">Automated</span>
            <strong>{isTh ? 'Deploy GitHub Pages' : 'GitHub Pages Deploy'}</strong>
            <small>{isTh ? 'อัปเดตหน้าเว็บทันทีเมื่อมีข้อมูลใหม่' : 'Triggered on every data commit'}</small>
          </div>
        </div>
      </div>
    </section>
  );
}
