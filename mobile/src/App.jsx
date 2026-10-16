/*
 * iCRM — the app. One app for every company: it is told the address of the
 * company's CRM once (Connect), then the person signs in, and the app shows
 * what that CRM has (its modules, its fields, its rules).
 */
import { useEffect, useRef, useState } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { get } from './lib/store';
import { renewIfOld } from './lib/api';
import { AppProvider, useApp, listen } from './lib/app';
import { Toast } from './components/ui';
// (a meeting recording waiting in the outbox is read from the phone when it is sent: registered at the start)
import './lib/meetrec';
import Connect from './screens/Connect';
import Login from './screens/Login';
import Home from './screens/Home';
import ModuleList from './screens/ModuleList';
import RecordView from './screens/RecordView';
import RecordForm from './screens/RecordForm';
import VisitStart from './screens/VisitStart';
import VisitOpen from './screens/VisitOpen';
import VisitView from './screens/VisitView';
import Nearby from './screens/Nearby';
import Team from './screens/Team';
import OrderNew from './screens/OrderNew';
import CallLog from './screens/CallLog';
import PhoneCalls from './screens/PhoneCalls';
import RecordingsCheck from './screens/RecordingsCheck';
import ScanCard from './screens/ScanCard';
import Plans from './screens/Plans';
import TodayRoute from './screens/TodayRoute';
import Leave from './screens/Leave';
import Approvals from './screens/Approvals';
import Expenses from './screens/Expenses';
import More from './screens/More';
import MyDay from './screens/MyDay';

function Signed({ children }) {
  const { boot, refreshBoot, refreshDay, sync, signedOut } = useApp();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!get('token')) return;
    renewIfOld();
    refreshBoot().then(() => { refreshDay(); sync(); }).catch((e) => { if (!get('boot')) setError(e.message); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!get('server')) return <Navigate to="/connect" replace />;
  if (!get('token') || signedOut) return <Navigate to="/login" replace />;
  if (!boot) {
    return (
      <div className="screen no-nav"><div className="body" style={{ paddingTop: 80 }}>
        {error ? (
          <div className="card col center">
            <div className="strong">Could not reach the CRM</div>
            <div className="muted small">{error}</div>
            <button type="button" className="btn primary" onClick={() => { setError(''); refreshBoot().catch((e) => setError(e.message)); }}>Try again</button>
          </div>
        ) : <div className="loading">Loading…</div>}
      </div></div>
    );
  }
  return children;
}

// the phone's Back button: back a screen, or close the app on Home
function BackButton() {
  const nav = useNavigate();
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => listen(CapApp.addListener('backButton', ({ canGoBack }) => {
    if (window.location.hash === '#/' || window.location.hash === '' || !canGoBack) CapApp.exitApp();
    else navRef.current(-1);
  })), []);
  return null;
}

export default function App() {
  return (
    <AppProvider>
      <HashRouter>
        <BackButton />
        <Routes>
          <Route path="/connect" element={<Connect />} />
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Signed><Home /></Signed>} />
          <Route path="/day" element={<Signed><MyDay /></Signed>} />
          <Route path="/m/:module" element={<Signed><ModuleList /></Signed>} />
          <Route path="/m/:module/new" element={<Signed><RecordForm /></Signed>} />
          <Route path="/m/:module/:id" element={<Signed><RecordView /></Signed>} />
          <Route path="/m/:module/:id/edit" element={<Signed><RecordForm /></Signed>} />
          <Route path="/visit/new" element={<Signed><VisitStart /></Signed>} />
          <Route path="/visit" element={<Signed><VisitOpen /></Signed>} />
          <Route path="/visits/:id" element={<Signed><VisitView /></Signed>} />
          <Route path="/nearby" element={<Signed><Nearby /></Signed>} />
          <Route path="/team" element={<Signed><Team /></Signed>} />
          <Route path="/order/new" element={<Signed><OrderNew /></Signed>} />
          <Route path="/call/:module/:id" element={<Signed><CallLog /></Signed>} />
          <Route path="/calls/phone" element={<Signed><PhoneCalls /></Signed>} />
          <Route path="/calls/recordings" element={<Signed><RecordingsCheck /></Signed>} />
          <Route path="/scan-card" element={<Signed><ScanCard /></Signed>} />
          <Route path="/plans" element={<Signed><Plans /></Signed>} />
          <Route path="/plans/:day" element={<Signed><Plans /></Signed>} />
          <Route path="/route" element={<Signed><TodayRoute /></Signed>} />
          <Route path="/leave" element={<Signed><Leave /></Signed>} />
          <Route path="/approvals" element={<Signed><Approvals /></Signed>} />
          <Route path="/expenses" element={<Signed><Expenses /></Signed>} />
          <Route path="/more" element={<Signed><More /></Signed>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toast />
      </HashRouter>
    </AppProvider>
  );
}
