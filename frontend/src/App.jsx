import { useState, useRef, useEffect, useCallback } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "./firebase";
import AuthPage from "./AuthPage";
import ParticleBackground from "./ParticleBackground";
import "./app.css";

const STEPS = [
  { id: "joining",      label: "Joining Meeting"  },
  { id: "recording",    label: "Recording"        },
  { id: "processing",   label: "Processing Audio" },
  { id: "transcribing", label: "Transcribing"     },
  { id: "summarizing",  label: "Analyzing"        },
];

const TABS = [
  { id: "overview",   label: "Overview"     },
  { id: "bullets",    label: "Key Points"   },
  { id: "actions",    label: "Action Items" },
  { id: "questions",  label: "Questions"    },
  { id: "transcript", label: "Transcript"   },
];

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function stripMd(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/gs, "$1").replace(/\*(.+?)\*/gs, "$1")
    .replace(/_{2}(.+?)_{2}/gs, "$1").replace(/_(.+?)_/gs, "$1")
    .replace(/#{1,6}\s+/g, "").replace(/`{1,3}([^`]*)`{0,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "").replace(/^\d+\.\s+/gm, "").trim();
}

export default function App() {
  // ── Auth state (all hooks must be declared before any conditional returns) ──
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out

  // ── Dashboard state ──
  const [link, setLink]                     = useState("");
  const [phase, setPhase]                   = useState("idle");
  const [currentStep, setCurrentStep]       = useState(null);
  const [statusMessages, setStatusMessages] = useState([]);
  const [errorMsg, setErrorMsg]             = useState("");
  const [currentMeeting, setCurrentMeeting] = useState(null);
  const [meetingDate, setMeetingDate]       = useState(null);
  const [activeTab, setActiveTab]           = useState("overview");
  const [meetings, setMeetings]             = useState([]);
  const [historyLoading, setHistLoading]    = useState(false);
  const [selectedKey, setSelectedKey]       = useState(null);
  const [detailLoading, setDetailLoad]      = useState(false);
  const [showModal, setShowModal]           = useState(false);
  const [copied, setCopied]                 = useState(false);
  const [editingTitle, setEditingTitle]     = useState(false);
  const [titleDraft, setTitleDraft]         = useState("");
  const [renaming, setRenaming]             = useState(false);

  const logRef   = useRef(null);
  const esRef    = useRef(null);
  const phaseRef = useRef("idle");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u ?? null));
    return unsub;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [statusMessages]);

  const fetchMeetings = useCallback(async () => {
    if (!user) return;
    setHistLoading(true);
    try {
      const uid = user.uid || "";
      const r = await fetch(`http://localhost:3000/meetings?uid=${encodeURIComponent(uid)}`);
      const d = await r.json();
      setMeetings(Array.isArray(d) ? d : []);
    } catch { setMeetings([]); }
    finally   { setHistLoading(false); }
  }, [user]);

  useEffect(() => { if (user) fetchMeetings(); }, [fetchMeetings, user]);

  const openMeeting = async (m) => {
    setSelectedKey(m.key);
    setDetailLoad(true);
    setActiveTab("overview");
    setEditingTitle(false);
    try {
      const r = await fetch(`http://localhost:3000/meeting?key=${encodeURIComponent(m.key)}`);
      const d = await r.json();
      setCurrentMeeting(d);
      setMeetingDate(m.date);
      phaseRef.current = "idle";
      setPhase("idle");
    } catch { }
    finally   { setDetailLoad(false); }
  };

  const renameM = async () => {
    if (!titleDraft.trim() || !selectedKey || renaming) return;
    setRenaming(true);
    try {
      await fetch("http://localhost:3000/meeting", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: selectedKey, title: titleDraft.trim() }),
      });
      setCurrentMeeting(prev => ({ ...prev, title: titleDraft.trim() }));
      setMeetings(prev => prev.map(m =>
        m.key === selectedKey ? { ...m, title: titleDraft.trim() } : m
      ));
    } catch {}
    setRenaming(false);
    setEditingTitle(false);
  };

  const goHome = () => {
    setCurrentMeeting(null);
    setMeetingDate(null);
    setSelectedKey(null);
    setActiveTab("overview");
    setEditingTitle(false);
    if (phase === "error") setPhase("idle");
  };

  const handleCopy = () => {
    if (!currentMeeting) return;
    const parts = [
      currentMeeting.title && `Meeting: ${stripMd(currentMeeting.title)}`,
      currentMeeting.overview && `Overview:\n${stripMd(currentMeeting.overview)}`,
      currentMeeting.bulletPoints?.length && `Key Points:\n${currentMeeting.bulletPoints.map(p => `• ${stripMd(p)}`).join("\n")}`,
      currentMeeting.actionItems?.length  && `Action Items:\n${currentMeeting.actionItems.map(a => `• ${stripMd(a.task)}${a.owner ? ` (${stripMd(a.owner)})` : ""}`).join("\n")}`,
    ].filter(Boolean).join("\n\n");
    navigator.clipboard.writeText(parts);
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const startBot = () => {
    if (!link.trim()) return;
    setShowModal(false);
    setPhase("running");
    phaseRef.current = "running";
    setCurrentStep("joining");
    setStatusMessages([]);
    setCurrentMeeting(null);
    setMeetingDate(null);
    setSelectedKey(null);
    setErrorMsg("");
    if (esRef.current) esRef.current.close();

    const uid = user?.uid || "";
    const es = new EventSource(`http://localhost:3000/start?meetLink=${encodeURIComponent(link.trim())}&uid=${encodeURIComponent(uid)}`);
    esRef.current = es;

    es.addEventListener("status", (e) => {
      const d = JSON.parse(e.data);
      setCurrentStep(d.step);
      setStatusMessages(prev => [...prev, { text: d.message }]);
    });

    es.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      setCurrentMeeting(d.meetingData);
      setMeetingDate(new Date().toISOString());
      if (d.s3Key) setSelectedKey(d.s3Key);
      phaseRef.current = "idle";
      setPhase("idle");
      setCurrentStep(null);
      setActiveTab("overview");
      setEditingTitle(false);
      es.close();
      fetchMeetings();
    });

    es.addEventListener("error", (e) => {
      if (e.data) {
        try { setErrorMsg(JSON.parse(e.data).message || "An error occurred."); }
        catch { setErrorMsg("Connection error."); }
      } else {
        if (phaseRef.current !== "idle") setErrorMsg("Connection lost. Is the backend running?");
        else return;
      }
      phaseRef.current = "error";
      setPhase("error");
      es.close();
    });
  };

  const reset = () => {
    if (esRef.current) esRef.current.close();
    phaseRef.current = "idle";
    setPhase("idle");
    setCurrentStep(null);
    setStatusMessages([]);
    setCurrentMeeting(null);
    setMeetingDate(null);
    setSelectedKey(null);
    setErrorMsg("");
    setLink("");
    setEditingTitle(false);
  };

  const stepIndex   = STEPS.findIndex(s => s.id === currentStep);
  const showSummary = phase === "idle" && currentMeeting && !detailLoading;
  const showHero    = phase === "idle" && !currentMeeting && !detailLoading;
  const showHome    = showSummary || phase === "running" || phase === "error";

  const handleSignOut = () => signOut(auth);

  if (user === undefined) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #c9d6ff 0%, #d8b4fe 28%, #a5f3fc 62%, #bbf7d0 100%)'
      }}>
        <div style={{
          width: 42, height: 42,
          border: '3.5px solid rgba(99,102,241,0.18)',
          borderTopColor: '#6366f1',
          borderRadius: '50%',
          animation: 'spin 0.75s linear infinite'
        }} />
      </div>
    );
  }

  if (!user) return <AuthPage />;

  return (
    <div className="app">
      <ParticleBackground />

      {/* ══ Home Pill (top-left, always visible) ══ */}
      <button className="btn-float-home" onClick={goHome} id="home-fab">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9,22 9,12 15,12 15,22"/>
        </svg>
        Home
      </button>

      {/* ══ User Avatar Pill (top-right, always visible) ══ */}
      <div className="user-pill" id="user-pill">
        <div className="user-avatar">
          {user?.photoURL
            ? <img src={user.photoURL} alt="avatar" className="user-avatar-img" />
            : <span className="user-avatar-initials">{(user?.email?.[0] || "U").toUpperCase()}</span>
          }
        </div>
        <span className="user-email" title={user?.email}>
          {user?.displayName || user?.email?.split("@")[0] || "User"}
        </span>
        <button className="user-signout" onClick={handleSignOut} id="signout-btn" title="Sign out">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16,17 21,12 16,7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </button>
      </div>

      {/* ══════════ DASHBOARD ══════════ */}
      <div className="dashboard">

        {/* ─── MAIN PANEL ─── */}
        <main className="main-panel">

          {/* ── Hero ── */}
          {showHero && (
            <div className="hero-state" id="hero-section">
              {/* Background orbs */}
              <div className="hero-orb hero-orb-1" />
              <div className="hero-orb hero-orb-2" />
              <div className="hero-orb hero-orb-3" />

              <div className="hero-content">
                <div className="hero-icon-wrap">
                  <span className="hero-icon">🎯</span>
                </div>

                <div className="hero-title-block">
                  <h1 className="hero-brand">Scribe <span className="hero-accent">GoogleAI</span></h1>
                  <p className="hero-tagline">Your intelligent meeting companion</p>
                </div>

                <div className="hero-features">
                  <div className="hero-feat">
                    <span className="hero-feat-icon">🎙️</span>
                    <div>
                      <strong>Auto-Join & Record</strong>
                      <p>Bot enters your Google Meet</p>
                    </div>
                  </div>
                  <div className="hero-feat">
                    <span className="hero-feat-icon">📝</span>
                    <div>
                      <strong>Transcribe</strong>
                      <p>Word-perfect Whisper transcripts</p>
                    </div>
                  </div>
                  <div className="hero-feat">
                    <span className="hero-feat-icon">✨</span>
                    <div>
                      <strong>AI Insights</strong>
                      <p>Summaries, actions & questions</p>
                    </div>
                  </div>
                </div>

                <button
                  className="btn-hero"
                  onClick={() => setShowModal(true)}
                  id="hero-start-btn"
                >
                  <span>Start New Recording</span>
                  <span className="btn-hero-arrow">→</span>
                </button>
              </div>
            </div>
          )}

          {/* ── Running ── */}
          {phase === "running" && (
            <div className="prog-card">
              <div className="prog-top">
                <div className="live-pill">
                  <span className="live-dot" /> Recording in progress
                </div>
                <button className="btn-ghost-sm" onClick={reset} id="cancel-btn">Cancel</button>
              </div>

              <div className="pipeline">
                {STEPS.map((step, i) => {
                  const done   = stepIndex > i;
                  const active = stepIndex === i;
                  return (
                    <div key={step.id} className={`pipe-row ${done ? "is-done" : ""} ${active ? "is-active" : ""}`}>
                      {i < STEPS.length - 1 && <div className="pipe-track" />}
                      <div className="pipe-circle">
                        {done ? <span className="pipe-check">✓</span>
                               : active ? <span className="pipe-pulse" /> : null}
                      </div>
                      <div className="pipe-body">
                        <span className="pipe-label">{step.label}</span>
                        {active && <span className="pipe-tag">In progress</span>}
                        {done   && <span className="pipe-tag is-done-tag">Done</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="log-box" ref={logRef}>
                {statusMessages.map((m, i) => (
                  <div key={i} className="log-row">
                    <span className="log-caret">›</span>
                    <span className="log-txt">{m.text}</span>
                  </div>
                ))}
                {!statusMessages.length && <span className="log-txt log-muted">Waiting for bot…</span>}
              </div>
            </div>
          )}

          {/* ── Error ── */}
          {phase === "error" && (
            <div className="center-state">
              <div className="state-icon state-icon--err">⚠</div>
              <h2 className="state-title">Something went wrong</h2>
              <p className="state-sub">{errorMsg}</p>
              <button className="btn-primary" onClick={reset} id="retry-btn">Try Again</button>
            </div>
          )}

          {/* ── Loading ── */}
          {detailLoading && (
            <div className="center-state">
              <div className="spinner" />
              <p className="state-sub">Loading meeting…</p>
            </div>
          )}

          {/* ── Meeting Summary ── */}
          {showSummary && (
            <div className="summary-view">

              <div className="meta-card">
                <div className="meta-left">
                  <div className="meta-icon">📊</div>
                  <div className="meta-info">
                    <div className="meta-title-row">
                      {editingTitle ? (
                        <>
                          <input
                            className="title-edit-input"
                            value={titleDraft}
                            onChange={e => setTitleDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") renameM();
                              if (e.key === "Escape") setEditingTitle(false);
                            }}
                            autoFocus
                            id="title-edit-input"
                          />
                          <button className="btn-title-action btn-title-save" onClick={renameM} disabled={renaming} id="title-save-btn">
                            {renaming ? "…" : "Save"}
                          </button>
                          <button className="btn-title-action btn-title-cancel" onClick={() => setEditingTitle(false)} id="title-cancel-btn">
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <h1 className="meta-title">
                            {stripMd(currentMeeting.title) || "Meeting Recording"}
                          </h1>
                          <button
                            className="btn-title-edit"
                            onClick={() => { setTitleDraft(stripMd(currentMeeting.title) || "Meeting Recording"); setEditingTitle(true); }}
                            title="Rename meeting"
                            id="title-edit-btn"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                    <div className="meta-chips">
                      {meetingDate && <>
                        <span className="chip">📅 {formatDate(meetingDate)}</span>
                        <span className="chip">🕐 {formatTime(meetingDate)}</span>
                      </>}
                      {currentMeeting.participants?.length > 0 && (
                        <span className="chip">👥 {currentMeeting.participants.map(stripMd).join(", ")}</span>
                      )}
                    </div>
                  </div>
                </div>
                <button className="btn-copy-summary" onClick={handleCopy} id="copy-btn">
                  {copied ? "✓ Copied!" : "Copy Summary"}
                </button>
              </div>

              <div className="tab-bar-wrap">
                <div className="tab-bar" role="tablist">
                  {TABS.map(t => (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={activeTab === t.id}
                      className={`tab ${activeTab === t.id ? "tab--on" : ""}`}
                      onClick={() => setActiveTab(t.id)}
                      id={`tab-${t.id}`}
                    >
                      {t.label}
                      {t.id === "actions" && currentMeeting.actionItems?.length > 0 && (
                        <span className="tab-badge">{currentMeeting.actionItems.length}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="tab-panel" role="tabpanel" key={activeTab}>

                {activeTab === "overview" && (
                  <div className="pane fade-in">
                    {currentMeeting.overview ? (
                      <div className="overview-box">
                        <div className="overview-label">Summary</div>
                        <p className="overview-text">{stripMd(currentMeeting.overview)}</p>
                      </div>
                    ) : <EmptyPane msg="No overview available." />}
                  </div>
                )}

                {activeTab === "bullets" && (
                  <div className="pane fade-in">
                    {currentMeeting.bulletPoints?.length > 0 ? (
                      <ul className="bullet-list">
                        {currentMeeting.bulletPoints.map((pt, i) => (
                          <li key={i} className="bullet-item">
                            <span className="bullet-num">{i + 1}</span>
                            <span>{stripMd(pt)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <EmptyPane msg="No key points recorded for this meeting." />}
                  </div>
                )}

                {activeTab === "actions" && (
                  <div className="pane fade-in">
                    {currentMeeting.actionItems?.length > 0 ? (
                      <div className="action-list">
                        {currentMeeting.actionItems.map((a, i) => (
                          <div key={i} className="action-card">
                            <div className="action-check">✓</div>
                            <div className="action-body">
                              <p className="action-task">{stripMd(a.task)}</p>
                              <div className="action-meta">
                                {a.owner    && <span className="tag tag--owner">👤 {stripMd(a.owner)}</span>}
                                {a.deadline && <span className="tag tag--date">📅 {stripMd(a.deadline)}</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyPane msg="No action items identified." />}
                  </div>
                )}

                {activeTab === "questions" && (
                  <div className="pane fade-in">
                    {currentMeeting.questions?.length > 0 ? (
                      <div className="question-list">
                        {currentMeeting.questions.map((q, i) => (
                          <div key={i} className="question-card">
                            <span className="q-num">{i + 1}</span>
                            <p className="q-text">{stripMd(q)}</p>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyPane msg="No questions or insights recorded." />}
                  </div>
                )}

                {activeTab === "transcript" && (
                  <div className="pane fade-in">
                    {currentMeeting.transcript ? (
                      <div className="transcript-box">
                        <pre className="transcript-pre">{currentMeeting.transcript}</pre>
                      </div>
                    ) : <EmptyPane msg="No transcript available." />}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* ─── SIDEBAR ─── */}
        <aside className="sidebar" id="sidebar">
          <div className="sb-header">
            <div className="sb-header-left">
              <div className="sb-brand">
                <div className="sb-brand-dot">🎯</div>
                <span className="sb-title">Past Meetings</span>
              </div>
              {meetings.length > 0 && <span className="sb-badge">{meetings.length}</span>}
            </div>
            <button
              className={`refresh-btn ${historyLoading ? "spinning" : ""}`}
              onClick={fetchMeetings}
              title="Refresh"
              id="refresh-btn"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
            </button>
          </div>

          <div className="sb-list">
            {historyLoading && !meetings.length && (
              <div className="sb-empty"><div className="spinner-sm" /><span>Loading…</span></div>
            )}
            {!historyLoading && !meetings.length && (
              <div className="sb-empty">
                <div className="sb-empty-icon">🗂️</div>
                <p className="sb-empty-title">No meetings yet</p>
                <p className="sb-empty-sub">Your recorded meetings appear here automatically.</p>
              </div>
            )}
            {meetings.map((m, idx) => (
              <button
                key={m.key}
                className={`sb-item ${selectedKey === m.key ? "sb-item--on" : ""}`}
                onClick={() => openMeeting(m)}
                id={`meeting-${idx}`}
              >
                <div className="sb-item-avatar">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <path d="M7 8h10M7 12h10M7 16h6" />
                  </svg>
                </div>
                <div className="sb-item-info">
                  <div className="sb-item-name" title={m.title || `Meeting ${meetings.length - idx}`}>
                    {m.title || `Meeting ${meetings.length - idx}`}
                  </div>
                  <div className="sb-item-date">{formatDate(m.date)}</div>
                  <div className="sb-item-time">{formatTime(m.date)}</div>
                </div>
                {selectedKey === m.key && <div className="sb-item-dot" />}
              </button>
            ))}
          </div>
        </aside>
      </div>

      {/* ══ Floating New Recording Button (bottom-left) ══ */}
      <button
        className="btn-float-new"
        onClick={() => setShowModal(true)}
        disabled={phase === "running"}
        id="new-recording-fab"
        title="Start New Recording"
      >
        <span className="fab-plus">+</span>
        <span>New Recording</span>
      </button>

      {/* ══ Modal ══ */}
      {showModal && (
        <div className="overlay" onClick={() => setShowModal(false)} id="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} id="new-recording-modal">
            <div className="modal-head">
              <div>
                <h2 className="modal-title">Start New Recording</h2>
                <p className="modal-sub">The AI bot joins, records and summarises automatically</p>
              </div>
              <button className="modal-close" onClick={() => setShowModal(false)} id="modal-close">✕</button>
            </div>
            <div className="modal-body">
              <label className="field-label" htmlFor="meet-url">Google Meet URL</label>
              <div className="field-row">
                <input
                  id="meet-url"
                  className="field-input"
                  placeholder="https://meet.google.com/xxx-xxxx-xxx"
                  value={link}
                  onChange={e => setLink(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && startBot()}
                  autoFocus
                />
                <button className="btn-launch" onClick={startBot} id="launch-btn">
                  Launch Bot →
                </button>
              </div>
              <p className="field-hint">
                The bot joins as <strong>Scribe GoogleAI</strong>. Admit it from the waiting room if prompted.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ══ Toast ══ */}
      {copied && (
        <div className="toast" id="copy-toast">
          <span className="toast-icon">✓</span>
          Copied to clipboard
        </div>
      )}

    </div>
  );
}

function EmptyPane({ msg }) {
  return (
    <div className="empty-pane">
      <span className="empty-pane-icon">📭</span>
      <p>{msg}</p>
    </div>
  );
}