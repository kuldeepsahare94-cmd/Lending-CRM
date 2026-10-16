import lazy from './lazyWithRecovery';
import { registerRoutePreloads } from './routePreload';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoanHome from './pages/loans/LoanHome';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import SupportShell, { MaybeSupportShell } from './pages/support/SupportShell';

// Eager: these are needed for the very first paint (or to recover from a
// failed one), so code-splitting them would only add a round-trip.
import Login from './pages/Login';
import NotFound from './pages/NotFound';

// Everything else is split per route. Each page becomes its own chunk that
// is fetched the first time the user navigates to it, which keeps the
// initial bundle to the shell plus the landing page. <Suspense> lives
// inside Layout (around <Outlet/>), so the sidebar and header stay on
// screen while a chunk loads instead of the whole app blanking.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Leads = lazy(() => import('./pages/Leads'));
const LeadDetail = lazy(() => import('./pages/LeadDetail'));
const Reports = lazy(() => import('./pages/Reports'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const TeamChat = lazy(() => import('./pages/TeamChat'));
const SettingsSecurity = lazy(() => import('./pages/SettingsSecurity'));
const ExtensionScreen = lazy(() => import('./extensions/ExtensionScreen'));
const SettingsCalendar = lazy(() => import('./pages/SettingsCalendar'));
const Roles = lazy(() => import('./pages/Roles'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const SettingsModules = lazy(() => import('./pages/SettingsModules'));
const FieldLayoutManager = lazy(() => import('./pages/FieldLayoutManager'));
const SettingsWorkflows = lazy(() => import('./pages/SettingsWorkflows'));
const SettingsPipelines = lazy(() => import('./pages/SettingsPipelines'));
const SettingsTeams = lazy(() => import('./pages/SettingsTeams'));
const SettingsData = lazy(() => import('./pages/SettingsData'));
const SettingsFinance = lazy(() => import('./pages/SettingsFinance'));
const SettingsCompany = lazy(() => import('./pages/SettingsCompany'));
const SettingsTemplates = lazy(() => import('./pages/SettingsTemplates'));
const SettingsTemplateLibrary = lazy(() => import('./pages/SettingsTemplateLibrary'));
const CallReports = lazy(() => import('./pages/CallReports'));
const Customer360 = lazy(() => import('./pages/Customer360'));
const SettingsEmail = lazy(() => import('./pages/SettingsEmail'));
const SettingsOptions = lazy(() => import('./pages/SettingsOptions'));
const SettingsNotifications = lazy(() => import('./pages/SettingsNotifications'));
const Duplicates = lazy(() => import('./pages/Duplicates'));
const SettingsTelephony = lazy(() => import('./pages/SettingsTelephony'));
const Dialer = lazy(() => import('./pages/Dialer'));
const LiveCalls = lazy(() => import('./pages/LiveCalls'));
const Expenses = lazy(() => import('./pages/expenses/Expenses'));
const ExpenseClaim = lazy(() => import('./pages/expenses/ClaimDetail'));
const SettingsExpenses = lazy(() => import('./pages/SettingsExpenses'));
const FieldTeam = lazy(() => import('./pages/field/FieldTeam'));
const SettingsField = lazy(() => import('./pages/SettingsField'));
const Inbox = lazy(() => import('./pages/Inbox'));
const EmailCampaigns = lazy(() => import('./pages/EmailCampaigns'));
const Appearance = lazy(() => import('./pages/Appearance'));
const WhatsAppIntegrations = lazy(() => import('./pages/WhatsAppIntegrations'));
const WhatsAppTemplates = lazy(() => import('./pages/WhatsAppTemplates'));
const WhatsAppWorkflows = lazy(() => import('./pages/WhatsAppWorkflows'));
const WhatsAppCampaigns = lazy(() => import('./pages/WhatsAppCampaigns'));
const WhatsAppInbox = lazy(() => import('./pages/WhatsAppInbox'));
const WhatsAppAnalytics = lazy(() => import('./pages/WhatsAppAnalytics'));
const LeadSources = lazy(() => import('./pages/LeadSources'));
const UniversalList = lazy(() => import('./pages/universal/UniversalList'));
const UniversalDetail = lazy(() => import('./pages/universal/UniversalDetail'));
const UniversalKanban = lazy(() => import('./pages/universal/UniversalKanban'));
// Loan & Mortgage workspace
import LoanShell from './pages/loans/LoanShell';
const loanPage = (name) => lazy(() => import('./pages/loans/LoanPages').then((m) => ({ default: m[name] })));
const LoanDashboard = loanPage('LoanDashboard');
const LoanList = loanPage('LoanList');
const NewLoan = loanPage('NewLoan');
const LoanDetail = loanPage('LoanDetail');
const LoanLenders = loanPage('Lenders');
const LoanDrill = loanPage('LoanDrill');
const LoanPayments = loanPage('LoanPayments');
const LoanCollections = loanPage('LoanCollections');
// Support Desk workspace
const CommandCenter = lazy(() => import('./pages/support/CommandCenter'));
const SupportSettings = lazy(() => import('./pages/support/SupportSettings'));
const supportPage = (name) => lazy(() => import('./pages/support/SupportPages').then((m) => ({ default: m[name] })));
const MyWork = supportPage('MyWork');
const SupportInbox = supportPage('Inbox');
const SupportQueues = supportPage('Queues');
const SlaMonitor = supportPage('SlaMonitor');
const SupportEscalations = supportPage('EscalationsPage');
const ServiceRequests = supportPage('ServiceRequests');
const SupportCustomers = supportPage('Customers');
const KnowledgeBase = supportPage('KnowledgeBase');
const SupportReports = supportPage('Reports');
const SupportAnalytics = supportPage('Analytics');

// ---------------------------------------------------------------------------
// Performance: fetch page code before it is needed.
//
// The Dashboard is the first screen after login, so its chunk is fetched at
// once — while the person is still typing their password — and it renders
// the moment login succeeds instead of showing "Loading…" first.
//
// The pages a dashboard figure drills into (lead list, record lists,
// payments) and the detail pages are fetched a few seconds later, when the
// browser is idle, so the first drill-down click opens without a loading
// pause. Each chunk is downloaded once and cached; nothing is re-fetched.
// ---------------------------------------------------------------------------
Dashboard.preload();

// Page code for a path, fetched when the pointer rests on (or presses) a link
// to it — see Layout. Most specific patterns first.
registerRoutePreloads([
  [/^\/$/, Dashboard],
  [/^\/leads\/\d+$/, LeadDetail],
  [/^\/leads$/, Leads],
  [/^\/records\/[^/]+\/kanban$/, UniversalKanban],
  [/^\/records\/[^/]+\/\d+$/, UniversalDetail],
  [/^\/records\/[^/]+$/, UniversalList],
  [/^\/reports/, Reports],
  [/^\/call-reports/, CallReports],
  [/^\/customer-360\//, Customer360],
  [/^\/calendar/, CalendarPage],
  [/^\/chat/, TeamChat],
  [/^\/inbox/, Inbox],
  [/^\/users/, Users],
  [/^\/roles/, Roles],
  [/^\/settings\/modules/, SettingsModules],
  [/^\/settings\/options/, SettingsOptions],
  [/^\/settings\/notifications/, SettingsNotifications],
  [/^\/settings\/company/, SettingsCompany],
  [/^\/settings\/data/, SettingsData],
  [/^\/settings$/, Settings],
  [/^\/whatsapp\/inbox/, WhatsAppInbox],
  [/^\/support\/?$/, CommandCenter],
]);

if (typeof window !== 'undefined') {
  const whenIdle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 5000 })
    : (cb) => setTimeout(cb, 1);
  // The everyday pages are fetched in the background soon after sign-in, one
  // at a time when the browser is idle, so moving between modules never waits
  // for page code. The rest are fetched on hover (see Layout).
  const everyday = [Leads, UniversalList, UniversalDetail, LeadDetail, UniversalKanban,
    Reports, CallReports, CalendarPage, Customer360, Settings, TeamChat, Inbox];
  const next = () => {
    const page = everyday.shift();
    if (!page) return;
    Promise.resolve(page.preload()).catch(() => {}).finally(() => whenIdle(next));
  };
  setTimeout(() => whenIdle(next), 2500);
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
              <Route path="/" element={<LoanHome />} />
              {/* Common aliases — these previously matched nothing and
                  rendered a blank page. */}
              <Route path="/dashboard" element={<Navigate to="/" replace />} />
              <Route path="/accounts" element={<Navigate to="/records/accounts" replace />} />
              <Route path="/customers" element={<Navigate to="/records/accounts" replace />} />
              <Route path="/contacts" element={<Navigate to="/records/contacts" replace />} />
              <Route path="/tickets" element={<Navigate to="/records/tickets" replace />} />
              <Route path="/tasks" element={<Navigate to="/records/tasks" replace />} />
              <Route path="/leads" element={<Leads />} />
              <Route path="/leads/:id" element={<LeadDetail />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/call-reports" element={<CallReports />} />
              <Route path="/customer-360/:id" element={<Customer360 />} />
              <Route path="/roles" element={<Roles />} />
              <Route path="/users" element={<Users />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/modules" element={<SettingsModules />} />
              <Route path="/settings/layout" element={<FieldLayoutManager />} />
              <Route path="/settings/workflows" element={<SettingsWorkflows />} />
              <Route path="/settings/pipelines" element={<SettingsPipelines />} />
              <Route path="/settings/teams" element={<SettingsTeams />} />
              <Route path="/settings/data" element={<SettingsData />} />
              <Route path="/settings/finance" element={<SettingsFinance />} />
              <Route path="/settings/company" element={<SettingsCompany />} />
              <Route path="/settings/templates" element={<SettingsTemplates />} />
              <Route path="/settings/template-library" element={<SettingsTemplateLibrary />} />
              <Route path="/settings/email" element={<SettingsEmail />} />
              <Route path="/settings/options" element={<SettingsOptions />} />
              <Route path="/settings/notifications" element={<SettingsNotifications />} />
              <Route path="/duplicates" element={<Duplicates />} />
              <Route path="/settings/telephony" element={<SettingsTelephony />} />
              <Route path="/dialer" element={<Dialer />} />
              <Route path="/dialer/:id" element={<Dialer />} />
              <Route path="/live-calls" element={<LiveCalls />} />
              <Route path="/expenses" element={<Expenses />} />
              <Route path="/expenses/claims/:id" element={<ExpenseClaim />} />
              <Route path="/settings/expenses" element={<SettingsExpenses />} />
              <Route path="/field" element={<FieldTeam />} />
              <Route path="/settings/field" element={<SettingsField />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/email-campaigns" element={<EmailCampaigns />} />
              <Route path="/appearance" element={<Appearance />} />
              <Route path="/whatsapp" element={<WhatsAppIntegrations />} />
              <Route path="/whatsapp/templates" element={<WhatsAppTemplates />} />
              <Route path="/whatsapp/workflows" element={<WhatsAppWorkflows />} />
              <Route path="/whatsapp/campaigns" element={<WhatsAppCampaigns />} />
              <Route path="/whatsapp/inbox" element={<WhatsAppInbox />} />
              <Route path="/whatsapp/inbox/:id" element={<WhatsAppInbox />} />
              <Route path="/whatsapp/analytics" element={<WhatsAppAnalytics />} />
              <Route path="/lead-sources" element={<LeadSources />} />
              {/* Universal CRM modules (Accounts, Contacts, Opportunities, Quotations,
                  Products, Subscriptions, Tickets, and any admin-created custom module)
                  all share these three routes, driven by module/field metadata. */}
              {/* Support-module records (tickets, incidents, problems, ...) render
                  inside the Support Desk navigation; every other module is unchanged. */}
              <Route path="/records/:moduleApiName" element={<MaybeSupportShell><UniversalList /></MaybeSupportShell>} />
              <Route path="/records/:moduleApiName/kanban" element={<MaybeSupportShell><UniversalKanban /></MaybeSupportShell>} />
              <Route path="/records/:moduleApiName/:id" element={<MaybeSupportShell><UniversalDetail /></MaybeSupportShell>} />
              {/* Loans: dashboard, loan list, new loan, loan page and lenders. */}
              <Route path="/loans" element={<LoanShell />}>
                <Route index element={<LoanDashboard />} />
                <Route path="all" element={<LoanList />} />
                <Route path="drill/:metric" element={<LoanDrill />} />
                <Route path="payments" element={<LoanPayments />} />
                <Route path="collections" element={<LoanCollections />} />
                <Route path="new" element={<NewLoan />} />
                <Route path="lenders" element={<LoanLenders />} />
                <Route path=":id" element={<LoanDetail />} />
              </Route>
              {/* Support Desk: its own Command Center and workspace. */}
              <Route path="/support" element={<SupportShell />}>
                <Route index element={<CommandCenter />} />
                <Route path="my-work" element={<MyWork />} />
                <Route path="inbox" element={<SupportInbox />} />
                <Route path="queues" element={<SupportQueues />} />
                <Route path="sla" element={<SlaMonitor />} />
                <Route path="escalations" element={<SupportEscalations />} />
                <Route path="requests" element={<ServiceRequests />} />
                <Route path="kb" element={<KnowledgeBase />} />
                <Route path="customers" element={<SupportCustomers />} />
                <Route path="reports" element={<SupportReports />} />
                <Route path="analytics" element={<SupportAnalytics />} />
                <Route path="settings" element={<SupportSettings />} />
              </Route>
              {/* Catch-all: without this, any unmatched path renders an
                  empty tree, which looks identical to a crashed app. */}
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/chat" element={<TeamChat />} />
              <Route path="/settings/security" element={<SettingsSecurity />} />
          {/* Screens from features built for this customer only. One route
              serves them all; which exist is decided at runtime by what is
              installed on this customer's server. */}
          <Route path="/x/:route" element={<ExtensionScreen />} />
          <Route path="/settings/calendar" element={<SettingsCalendar />} />
          <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </AuthProvider>
  );
}
