"use strict";

/**
 * Small line icons. They inherit currentColor so every surface follows the
 * SiYuan theme; only the recording red is fixed by design.
 */
const ICONS = `
<symbol id="iconMeetingMic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>
</symbol>
<symbol id="iconMeetingMicOff" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9 5a3 3 0 0 1 6 0v6M9 9v2a3 3 0 0 0 4.8 2.4M5 11a7 7 0 0 0 10.6 6M12 18v3M8 21h8M3 3l18 18"/>
</symbol>
<symbol id="iconMeetingStop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>
</symbol>
<symbol id="iconMeetingPause" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
  <rect x="7" y="5" width="3.5" height="14" rx="1.4" fill="currentColor" stroke="none"/>
  <rect x="13.5" y="5" width="3.5" height="14" rx="1.4" fill="currentColor" stroke="none"/>
</symbol>
<symbol id="iconMeetingPlay" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
  <path d="M8 5.6c0-1 1.1-1.6 1.9-1.1l9.2 6.4c.8.5.8 1.7 0 2.2l-9.2 6.4c-.8.5-1.9 0-1.9-1.1V5.6Z" fill="currentColor" stroke="none"/>
</symbol>
<symbol id="iconMeetingOpen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M14 4h6v6M20 4l-8.5 8.5M9.5 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5"/>
</symbol>
<symbol id="iconMeetingPanel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14.5 4v16"/>
</symbol>
<symbol id="iconMeetingMore" viewBox="0 0 24 24" fill="currentColor">
  <circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>
</symbol>
<symbol id="iconMeetingWarning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 3.2 21.2 20H2.8L12 3.2Z"/><path d="M12 9v5"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/>
</symbol>
<symbol id="iconMeetingCheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="m5 12.5 4.2 4.2L19 7"/>
</symbol>
<symbol id="iconMeetingClose" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
  <path d="M6 6l12 12M18 6 6 18"/>
</symbol>
<symbol id="iconMeetingChevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="m7 10 5 5 5-5"/>
</symbol>
<symbol id="iconMeetingCalendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17M8 13h2M14 13h2M8 17h2M14 17h2"/>
</symbol>
<symbol id="iconMeetingTranscript" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 6.5h16M4 11h10M4 15.5h16M4 20h8"/>
</symbol>
<symbol id="iconMeetingSparkle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
  <path d="M12 3.5c.6 3.7 2.8 5.9 6.5 6.5-3.7.6-5.9 2.8-6.5 6.5-.6-3.7-2.8-5.9-6.5-6.5 3.7-.6 5.9-2.8 6.5-6.5Z"/>
  <path d="M18.5 15.5c.25 1.5 1.1 2.35 2.6 2.6-1.5.25-2.35 1.1-2.6 2.6-.25-1.5-1.1-2.35-2.6-2.6 1.5-.25 2.35-1.1 2.6-2.6Z"/>
</symbol>
<symbol id="iconMeetingSettings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.91Z"/>
</symbol>
<symbol id="iconMeetingFolder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3l2 2h7a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-10Z"/>
</symbol>
<symbol id="iconMeetingRefresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M20 11a8 8 0 0 0-14.9-3.5M4 5v4h4M4 13a8 8 0 0 0 14.9 3.5M20 19v-4h-4"/>
</symbol>
<symbol id="iconMeetingPlus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
  <path d="M12 5v14M5 12h14"/>
</symbol>
<symbol id="iconMeetingSearch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
  <circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/>
</symbol>
`;

module.exports = { ICONS };
