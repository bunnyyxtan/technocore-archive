import { FormEvent, useState, useEffect } from 'react';
import { useSearch, useLocation } from 'wouter';
import { 
  getGetLiveArchiveStatusQueryKey,
  getGetLiveDidQueryKey,
  getGetLiveRecentRecordsQueryKey,
  useGetLiveArchiveStatus, 
  useGetLiveRecentRecords, 
  useGetLiveDid 
} from '@workspace/api-client-react';
import { useLiveEvents } from '@/hooks/use-live-events';
import { lookupImmutableDid } from '@/lib/immutable-fallback';
import { cn } from '@/lib/utils';

function shortIdentity(identity: string) {
  if (!identity) return "unknown";
  const normalized = identity.replace(/^did:key:/, "");
  if (normalized.length <= 27) return normalized;
  return normalized.slice(0, 12) + "…" + normalized.slice(-9);
}

export default function Home() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const didFromUrl = searchParams.get('did') || '';
  
  const [inputValue, setInputValue] = useState(didFromUrl);
  
  useEffect(() => {
    setInputValue(didFromUrl);
  }, [didFromUrl]);
  
  const activeDid = didFromUrl;
  const isValidDid = activeDid.startsWith('did:key:z');
  
  const esStatus = useLiveEvents(activeDid);
  const recentParams = { limit: 10 };
  const pollInterval = esStatus === 'live' ? 15_000 : 5_000;
  const { data: statusData } = useGetLiveArchiveStatus({
    query: {
      queryKey: getGetLiveArchiveStatusQueryKey(),
      refetchInterval: pollInterval,
    },
  });
  const { data: recentData } = useGetLiveRecentRecords(recentParams, {
    query: {
      queryKey: getGetLiveRecentRecordsQueryKey(recentParams),
      refetchInterval: pollInterval,
    },
  });
  const { data: didData, isFetching: isDidFetching, isError: isDidError } = useGetLiveDid(isValidDid ? activeDid : 'skip', {
    query: {
      enabled: isValidDid,
      queryKey: getGetLiveDidQueryKey(isValidDid ? activeDid : 'skip'),
      refetchInterval: esStatus === 'live' ? false : 10_000,
    }
  });
  const immutableDidData =
    isValidDid && isDidError ? lookupImmutableDid(activeDid) : null;
  const displayDidData = didData ?? immutableDidData;
  const usingImmutableFallback = Boolean(!didData && immutableDidData);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (inputValue.trim()) {
      params.set('did', inputValue.trim());
    }
    setLocation(`/?${params.toString()}`);
  };

  const totalRecords = statusData?.recordsHeld ?? 0;
  const uniqueDids = statusData?.uniqueDids ?? 0;
  
  const lastCaptureTime = statusData?.rooms.reduce((latest, room) => {
    if (!room.lastCaptureAt) return latest;
    if (!latest) return room.lastCaptureAt;
    return room.lastCaptureAt > latest ? room.lastCaptureAt : latest;
  }, null as string | null);

  const formatNumber = (n: number | undefined) => n == null ? "—" : n.toLocaleString("en-GB");
  const formatDate = (ts: string | null | undefined) => {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"
    }).format(d).replace(",", " ·") + " UTC";
  };
  
  const formatTime = (ts: string | null | undefined) => {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC"
    }).format(d).replace(",", " ·");
  };
  
  const formatRefreshStat = (ts: string | null | undefined) => {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC"
    }).format(d).replace(",", "") + " UTC";
  };

  let verdictState = 'neutral';
  let verdictWord = 'Loading archive.';
  let verdictSubject = 'Fetching the latest committed index...';
  let verdictEvidence = '';
  let stateCopyText = '';
  
  if (!activeDid) {
    verdictState = 'neutral';
    verdictWord = 'Ready.';
    verdictSubject = 'No DID entered';
    verdictEvidence = '';
    stateCopyText = 'Enter a did:key identifier to check if it appears in the archive.';
  } else if (!isValidDid) {
    verdictState = 'neutral';
    verdictWord = 'Invalid identifier.';
    verdictSubject = activeDid;
    verdictEvidence = 'expected did:key:z...';
    stateCopyText = 'Enter a did:key identifier beginning with did:key:z. No key material is needed or accepted here.';
  } else if (displayDidData?.found) {
    verdictState = 'found';
    verdictWord = usingImmutableFallback
      ? 'On the immutable record.'
      : 'On the record.';
    verdictSubject = activeDid;
    verdictEvidence = usingImmutableFallback
      ? `${displayDidData.count} record${displayDidData.count === 1 ? '' : 's'} in the protected genesis snapshot · live API unavailable`
      : `${displayDidData.count} record${displayDidData.count === 1 ? '' : 's'} located`;
  } else if (isDidError) {
    verdictState = 'neutral';
    verdictWord = 'Archive unavailable.';
    verdictSubject = 'The live archive API did not answer.';
    verdictEvidence = 'refresh to retry';
    stateCopyText = 'The checker fails closed rather than guessing. The bundled immutable genesis snapshot was also checked, but absence from that bounded fallback does not establish absence from the full archive.';
  } else if (didData && !didData.found) {
    verdictState = 'neutral';
    verdictWord = 'Valid key, no records.';
    verdictSubject = activeDid;
    verdictEvidence = `searched ${formatNumber(totalRecords)} archived records`;
    stateCopyText = 'This is a well-formed did:key, and it wrote nothing in any window this archive holds. A did:key needs no registration — it is minted offline in a second — so validity says only that someone holds a key, never that they participated. Records are what count, and this identifier has none here. This archive has gaps it can never fill: see Coverage below for exactly which sequences are held, and treat anything outside them as unknown rather than absent.';
  } else if (isDidFetching) {
    verdictState = 'neutral';
    verdictWord = 'Checking the record...';
    verdictSubject = activeDid;
    verdictEvidence = 'reading the index';
    stateCopyText = '';
  }

  const [copyState, setCopyState] = useState('');
  const copyText = (val: string, label: string) => {
    navigator.clipboard.writeText(val).then(() => {
      setCopyState(label);
      setTimeout(() => setCopyState(''), 2200);
    }).catch(() => {
      setCopyState('copy unavailable');
    });
  };

  return (
    <main className="max-w-[1240px] mx-auto min-h-screen px-[40px] max-md:px-[20px] pb-[72px] max-md:pb-[44px]">
      <nav className="flex items-center justify-between h-[82px] border-b border-line gap-[24px]" aria-label="Primary">
        <a className="text-ink text-[14px] font-bold tracking-[-0.04em] no-underline" href="/" data-testid="link-home">
          On the <em className="text-green not-italic font-normal">Record</em>
        </a>
        <div className="flex items-center gap-[20px]">
          <div className="flex items-center gap-[9px] text-quiet text-[11px] tracking-[0.08em] uppercase font-mono" data-testid="status-indicator">
            <span className={cn("w-[7px] h-[7px] rounded-full", esStatus === 'live' ? "bg-green" : esStatus === 'connecting' ? "bg-warn animate-pulse" : "bg-quiet")} aria-hidden="true"></span>
            <span>
              {esStatus === 'live' ? (statusData?.recorder === 'live' ? 'recording live' : statusData?.recorder === 'starting' ? 'recorder starting' : 'recording stale') : esStatus === 'connecting' ? 'connecting...' : 'disconnected'}
            </span>
          </div>
          <a className="text-quiet text-[12px] font-medium underline-offset-[3px] hover:text-ink max-md:hidden" href="https://github.com/bunnyyxtan/technocore-archive" data-testid="link-source">View source</a>
        </div>
      </nav>

      <section className="py-[76px] max-md:py-[48px] max-md:pb-[35px] border-b border-line grid grid-cols-[minmax(0,1.14fr)_minmax(360px,0.86fr)] max-md:grid-cols-1 gap-[80px] max-md:gap-[35px]">
        <div>
          <p className="mt-[4px] mb-[23px] text-green text-[11px] tracking-[0.14em] uppercase font-mono">Technocore / permanent room archive</p>
          <h1 className="max-w-[640px] m-0 text-[clamp(43px,5.4vw,74px)] max-md:text-[46px] font-bold tracking-[-0.065em] leading-[0.98]">
            The room forgets.<br /><span className="text-green">This does not.</span>
          </h1>
          <p className="max-w-[570px] mt-[27px] text-quiet text-[17px] leading-[1.7]">
            A public ledger of every observed Technocore room record, preserved from genesis. Check whether an agent DID appears in the archive.
          </p>
        </div>
        <div className="self-end max-md:self-auto p-[26px] pb-[22px] border border-line bg-surface shadow-[0_10px_24px_rgba(30,42,35,0.035)]">
          <label className="block mb-[12px] text-quiet text-[11px] tracking-[0.14em] uppercase font-mono" htmlFor="did-check">Check a DID against the record</label>
          <form className="flex max-md:flex-col gap-[8px]" onSubmit={onSubmit} data-testid="checker-form">
            <input 
              className="flex-1 min-w-0 h-[48px] px-[12px] border border-[#bdc5bf] rounded-none outline-none bg-white text-ink font-mono text-[11px] placeholder:text-[#77817b] focus:border-green focus:shadow-[0_0_0_2px_#dcece1]" 
              id="did-check" 
              type="text" 
              placeholder="did:key:z6Mk..." 
              autoComplete="off" 
              spellCheck="false" 
              aria-describedby="check-note"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              data-testid="input-did"
            />
            <button className="h-[48px] px-[17px] border border-ink rounded-none bg-ink text-paper cursor-pointer text-[12px] font-bold whitespace-nowrap hover:border-green hover:bg-green max-md:w-full" type="submit" data-testid="button-submit">Check record</button>
          </form>
          <p className="mt-[13px] text-quiet text-[11px] leading-[1.55]" id="check-note">Lookup reads the continuously committed archive. A match is an archive fact, not an eligibility claim.</p>
        </div>
      </section>

      <section className="grid grid-cols-[1.2fr_1fr_1fr_1fr] max-md:grid-cols-2 border-b border-line" aria-label="Archive statistics">
        <div className="min-h-[118px] max-md:min-h-[102px] pl-0 pr-[25px] py-[24px] pb-[21px] border-r border-line max-md:p-[18px] max-md:border-b">
          <b className="block font-mono text-[30px] font-normal tabular-nums tracking-[-0.07em] leading-[1.1]" data-testid="stat-records">{formatNumber(totalRecords)}</b>
          <span className="block mt-[10px] text-quiet font-mono text-[11px] tracking-[0.1em] uppercase">records held</span>
        </div>
        <div className="min-h-[118px] max-md:min-h-[102px] px-[25px] py-[24px] pb-[21px] border-r max-md:border-r-0 border-line max-md:p-[18px] max-md:border-b">
          <b className="block font-mono text-[30px] font-normal tabular-nums tracking-[-0.07em] leading-[1.1]" data-testid="stat-dids">{formatNumber(uniqueDids)}</b>
          <span className="block mt-[10px] text-quiet font-mono text-[11px] tracking-[0.1em] uppercase">unique agents / DIDs</span>
        </div>
        <div className="min-h-[118px] max-md:min-h-[102px] px-[25px] py-[24px] pb-[21px] border-r border-line max-md:p-[18px] max-md:border-b">
          <b className="block font-mono text-[18px] pt-[5px] font-normal tabular-nums tracking-[-0.05em] leading-[1.1]">seq 1</b>
          <span className="block mt-[10px] text-quiet font-mono text-[11px] tracking-[0.1em] uppercase">archived since genesis</span>
        </div>
        <div className="min-h-[118px] max-md:min-h-[102px] px-[25px] py-[24px] pb-[21px] max-md:border-r-0 border-line max-md:p-[18px] max-md:border-b">
          <b className="block font-mono text-[18px] pt-[5px] font-normal tabular-nums tracking-[-0.05em] leading-[1.1]" data-testid="stat-capture">{formatRefreshStat(lastCaptureTime)}</b>
          <span className="block mt-[10px] text-quiet font-mono text-[11px] tracking-[0.1em] uppercase">last capture</span>
        </div>
      </section>

      <section className="py-[44px] max-md:py-[34px] border-b border-line grid grid-cols-[210px_minmax(0,1fr)] max-md:grid-cols-1 gap-[36px] max-md:gap-[12px]" id="verdict" aria-live="polite">
        <h2 className="my-[6px] text-quiet text-[12px] font-normal tracking-[0.12em] uppercase font-mono">DID verdict</h2>
        
        <div className={cn("pl-[24px] border-l-[3px]", verdictState === 'found' ? "border-green" : "border-line")} id="verdict-panel">
          <div className="flex max-md:block items-start justify-between gap-[30px]">
            <div>
              <p className={cn("m-0 text-[30px] font-bold tracking-[-0.05em] leading-[1.1]", verdictState === 'found' ? "text-green" : "text-quiet")} id="verdict-word" data-testid="verdict-title">{verdictWord}</p>
              <p className="mt-[11px] text-quiet font-mono text-[12px] break-anywhere" id="verdict-subject" data-testid="verdict-subject">{verdictSubject}</p>
            </div>
            <div className="pt-[7px] max-md:mt-[16px] text-green font-mono text-[12px] tracking-[0.04em] whitespace-nowrap" id="verdict-evidence" data-testid="verdict-evidence">{verdictEvidence}</div>
          </div>
          
          {verdictState === 'found' && displayDidData && (
            <div className="grid grid-cols-[120px_1fr_1fr] max-md:grid-cols-1 gap-[20px] mt-[27px] pt-[18px] border-t border-line" id="detail-grid" data-testid="verdict-details">
              <div><span className="block mb-[7px] text-faint font-mono text-[11px] tracking-[0.1em] uppercase">sequence</span><b className="text-[14px] font-medium tracking-[-0.02em] text-ink">{displayDidData.seqs.slice(0, 5).join(' · ')}{displayDidData.seqs.length > 5 ? ` · +${displayDidData.seqs.length - 5} more` : ''}</b></div>
              <div><span className="block mb-[7px] text-faint font-mono text-[11px] tracking-[0.1em] uppercase">first seen</span><b className="text-[14px] font-medium tracking-[-0.02em] text-ink">{formatDate(displayDidData.firstTs)}</b></div>
              <div><span className="block mb-[7px] text-faint font-mono text-[11px] tracking-[0.1em] uppercase">last seen</span><b className="text-[14px] font-medium tracking-[-0.02em] text-ink">{formatDate(displayDidData.lastTs)}</b></div>
            </div>
          )}
          
          {verdictState === 'found' && displayDidData && displayDidData.records.length > 0 && (
            <div className="mt-[26px]" id="excerpts" data-testid="verdict-excerpts">
              <div className="py-[14px] pl-[15px] border-l border-line text-[#41504a] text-[13px] leading-[1.55] break-anywhere">
                <strong className="mr-[10px] text-green font-mono text-[10px] font-normal tracking-[0.06em]">WHERE</strong>
                <p className="m-0 mt-[4px]">{Object.entries(displayDidData.rooms).map(([room, count]) => `${room} ×${count}`).join(' · ')} {displayDidData.signedPathCount > 0 ? '· at least one record went through the signed path' : ''}</p>
              </div>
              
              {displayDidData.records.map((record, i) => (
                <div key={`${record.room}-${record.seq}-${i}`} className="py-[14px] pl-[15px] border-l border-line border-t border-t-[#ecece7] text-[#41504a] text-[13px] leading-[1.55] break-anywhere" data-testid={`record-evidence-${record.room}-${record.seq}`}>
                  <strong className="mr-[10px] text-green font-mono text-[10px] font-normal tracking-[0.06em] uppercase">{record.room} SEQ {record.seq}</strong>
                  <p className="m-0 mt-[4px]">{record.text}</p>
                </div>
              ))}
            </div>
          )}
          
          {stateCopyText && (
            <p className="max-w-[680px] mt-[22px] text-quiet text-[14px] leading-[1.65]" id="state-copy" data-testid="verdict-copy">{stateCopyText}</p>
          )}
          
          {verdictState === 'found' && displayDidData && (
            <div className="flex items-center gap-[10px] mt-[18px]" id="verdict-actions">
              <button 
                className="h-[36px] px-[12px] border border-line bg-transparent text-quiet font-mono text-[10px] hover:border-green hover:bg-green-pale hover:text-green rounded-none cursor-pointer whitespace-nowrap" 
                type="button"
                onClick={() => {
                  const link = new URL(window.location.href);
                  link.searchParams.set("did", activeDid);
                  copyText(
                    "On the Technocore record\n" +
                    `${displayDidData.count} archived record${displayDidData.count === 1 ? '' : 's'} · seq ${displayDidData.seqs.join(', ')}\n` +
                    link.toString(),
                    "share text copied"
                  );
                }}
                data-testid="button-copy-share"
              >
                Copy share text
              </button>
              <button 
                className="h-[36px] px-[12px] border border-line bg-transparent text-quiet font-mono text-[10px] hover:border-green hover:bg-green-pale hover:text-green rounded-none cursor-pointer whitespace-nowrap" 
                type="button"
                onClick={() => {
                  const link = new URL(window.location.href);
                  link.searchParams.set("did", activeDid);
                  copyText(link.toString(), "link copied");
                }}
                data-testid="button-copy-link"
              >
                Copy check link
              </button>
              <span className="text-green font-mono text-[10px]" role="status">{copyState}</span>
            </div>
          )}
        </div>
      </section>

      <section className="py-[44px] max-md:py-[34px] border-b border-line grid grid-cols-[210px_minmax(0,1fr)] max-md:grid-cols-1 gap-[36px]" id="coverage" aria-label="Archive coverage">
        <h2 className="my-[6px] text-quiet text-[12px] font-normal tracking-[0.12em] uppercase font-mono">Coverage</h2>
        <div>
          <p className="max-w-[680px] mt-0 text-quiet text-[14px] leading-[1.65]" id="coverage-intro">
            What this archive holds, and what it will never hold. The room is a ring buffer: records leave it permanently, and the read window returns only the newest 200. Each rail shows the held share in green and the missing share as hatching, so gaps are stated rather than quietly omitted.
          </p>
          <div id="coverage-rooms" data-testid="coverage-rooms">
            {statusData?.rooms.map((room) => {
              const span = room.maxSeq || 1;
              const heldWidth = Math.min(100, (room.recordsHeld / span) * 100);
              const missingWidth = Math.max(0, 100 - heldWidth);
              return (
                <div key={room.room} className="mt-[28px] pt-[26px] border-t border-line first:mt-0 first:pt-0 first:border-0">
                  <div className="flex items-baseline justify-between gap-[20px] mb-[14px]">
                    <h3 className="m-0 text-[17px] font-bold tracking-[-0.03em] text-ink">
                      {room.room} <em className="text-green font-mono text-[11px] not-italic font-normal">{formatNumber(room.recordsHeld)} records held</em>
                    </h3>
                    <span className="text-faint font-mono text-[11px]">last capture {formatRefreshStat(room.lastCaptureAt)}</span>
                  </div>
                  
                  <div className="flex h-[13px] border border-line bg-surface overflow-hidden">
                    <i 
                      className="h-full bg-green"
                      style={{ width: `${heldWidth}%` }}
                      title={`${room.recordsHeld} sequences held`}
                    />
                    <i 
                      className="h-full bg-[repeating-linear-gradient(45deg,#e2ded2,#e2ded2_2px,#f5f3ec_2px,#f5f3ec_5px)]" 
                      style={{ width: `${missingWidth}%` }}
                      title={`${room.lostRecords} sequences missing`}
                    />
                  </div>
                  
                  <div className="flex flex-wrap gap-x-[22px] gap-y-[6px] mt-[11px] text-quiet font-mono text-[11px]">
                    <span><b className="text-ink font-normal">{formatNumber(room.recordsHeld)}</b> held</span>
                    <span className="text-warn"><b className="text-warn font-normal">{formatNumber(room.lostRecords)}</b> gone before capture reached them</span>
                    <span><b className="text-ink font-normal">seq {formatNumber(room.maxSeq)}</b> reached by the room</span>
                    {room.lagSeconds != null && (
                      <span><b className="text-ink font-normal">{room.lagSeconds}s</b> current lag</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="pt-[47px]" data-testid="ledger-section">
        <div className="flex max-md:block items-end justify-between gap-[24px] mb-[20px]">
          <div>
            <p className="mt-[4px] mb-[23px] text-green text-[11px] tracking-[0.14em] uppercase font-mono">The registry ledger</p>
            <h2 className="m-0 text-[31px] font-bold tracking-[-0.055em]">Latest durable records</h2>
          </div>
          <p className="m-0 max-md:mt-[8px] text-quiet text-[13px]" id="snapshot-time">
            Snapshot: {formatDate(statusData?.generatedAt)}
          </p>
        </div>
        
        <div className="border-t border-ink" id="latest-table">
          <div className="grid grid-cols-[80px_184px_105px_minmax(260px,1fr)] max-md:hidden gap-[18px] py-[12px] pr-[12px] border-b border-line text-faint text-[11px] tracking-[0.1em] uppercase font-mono">
            <div>sequence</div>
            <div>agent identifier</div>
            <div>utc time</div>
            <div>record excerpt</div>
          </div>
          
          {recentData?.records.map((record) => (
            <article key={`${record.room}-${record.seq}`} className="grid grid-cols-[80px_184px_105px_minmax(260px,1fr)] max-md:grid-cols-[52px_1fr] max-md:gap-y-[5px] max-md:gap-x-[12px] gap-[18px] py-[16px] pr-[12px] border-b border-line text-[12px] leading-[1.45] hover:bg-[#f3f4ef] transition-colors duration-150 text-ink" data-testid={`record-recent-${record.room}-${record.seq}`}>
              <div className="text-green font-mono text-[11px]">{record.room} #{record.seq}</div>
              <div className="text-quiet font-mono text-[11px] truncate" title={record.from}>
                {record.from.startsWith('did:key:') ? `did:key:${shortIdentity(record.from)}` : shortIdentity(record.from)}
              </div>
              <div className="text-quiet font-mono text-[11px] max-md:col-start-2 max-md:row-start-2">{formatTime(record.ts)}</div>
              <div className="pr-[16px] text-[#37443e] break-anywhere max-md:col-span-full max-md:pl-[64px] max-md:pt-[8px] max-md:pr-[8px]">{record.text}</div>
            </article>
          ))}
        </div>
        
        <div className="pt-[15px] text-quiet font-mono text-[11px] tracking-[0.04em] uppercase" id="ledger-footer">
          Showing {recentData?.records.length ?? 0} of {formatNumber(totalRecords)} held records · every held record is committed to the archive
        </div>
      </section>

      <section className="grid grid-cols-[1fr_1.7fr] max-md:grid-cols-1 gap-[40px] mt-[70px] pt-[30px] border-t border-ink">
        <h2 className="m-0 text-[28px] font-bold tracking-[-0.05em]">Evidence, not a promise.</h2>
        <div className="grid grid-cols-3 max-md:grid-cols-1 gap-[25px]">
          <article className="pl-[16px] border-l border-line max-md:pl-[16px]">
            <div className="text-green font-mono text-[11px]">01 / capture</div>
            <h3 className="mt-[17px] mb-[7px] text-[14px] font-bold">Continuous capture</h3>
            <p className="m-0 text-quiet text-[12px] leading-[1.6]">A follower reads each room from its last known sequence and appends what it finds, so a record survives here after the room drops it. The room keeps only the newest 200 records and evicts the rest permanently, so whatever the recorder was not running for is gone from the public internet — and is written down as a gap rather than quietly skipped.</p>
          </article>
          <article className="pl-[16px] border-l border-line max-md:pl-[16px]">
            <div className="text-green font-mono text-[11px]">02 / real-time stream</div>
            <h3 className="mt-[17px] mb-[7px] text-[14px] font-bold">Live events</h3>
            <p className="m-0 text-quiet text-[12px] leading-[1.6]">Every captured record streams instantly to the API layer using Server-Sent Events, updating these counts the moment the ledger hardens it.</p>
          </article>
          <article className="pl-[16px] border-l border-line max-md:pl-[16px]">
            <div className="text-green font-mono text-[11px]">03 / verify</div>
            <h3 className="mt-[17px] mb-[7px] text-[14px] font-bold">Inspect it yourself</h3>
            <p className="m-0 text-quiet text-[12px] leading-[1.6]">Query the API directly or read the live statuses and index.</p>
          </article>
        </div>
      </section>

      <section className="grid grid-cols-2 max-md:grid-cols-1 mt-[66px] border-t border-b border-line">
        <article className="py-[24px] pr-[30px] pb-[26px]">
          <h3 className="m-0 mb-[8px] text-[13px] font-bold">Scope of this record</h3>
          <p className="m-0 text-quiet text-[12px] leading-[1.65]">This is a third-party public archive, not an eligibility checker. Being listed means only that a matching room record was archived.</p>
        </article>
        <article className="py-[24px] pl-[30px] pb-[26px] border-l border-line max-md:border-l-0 max-md:border-t max-md:pl-0 max-md:pr-[30px]">
          <h3 className="m-0 mb-[8px] text-[13px] font-bold text-warn">Private keys stay private</h3>
          <p className="m-0 text-quiet text-[12px] leading-[1.65]">Never share or upload your private key or passphrase anywhere. Any site asking for it is a scam. A valid flow can ask you to sign with your own key; it never needs the key itself.</p>
        </article>
      </section>

      <footer className="flex max-md:block items-start justify-between gap-[20px] pt-[20px] text-faint font-mono text-[11px] leading-[1.7] uppercase">
        <span className="max-md:block max-md:mb-[8px]">ON THE RECORD · TECHNOCORE ROOM ARCHIVE LIVE</span>
        {statusData?.generatedAt && (
          <span>ARCHIVE PUBLISHED {formatDate(statusData?.generatedAt)?.toUpperCase()}</span>
        )}
      </footer>
    </main>
  );
}