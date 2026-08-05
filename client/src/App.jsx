import { lazy, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import ScrollToTop from './components/ScrollToTop.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import LoadingState from './components/LoadingState.jsx';
import DesktopIntro from './components/DesktopIntro.jsx';
import DesktopRoot from './components/DesktopRoot.jsx';
import { isDesktop } from './lib/platform.js';

/*
 * Two pages load with the app; the rest arrive when asked for.
 *
 * Everything used to be one import list, which meant one bundle: 1.19 MB, and
 * every visitor paid for all of it before seeing the homepage. That included
 * recharts and the whole dashboard, downloaded in full by someone who had come
 * to read the pricing page. For pharmacies on Nigerian mobile data, that is
 * real money and real waiting.
 *
 * Home and SignIn stay eager, because they are the two first paints that
 * exist. The website opens on Home; the desktop app opens on SignIn (see
 * DesktopRoot, which imports it directly). Making either lazy would trade a
 * smaller bundle for a spinner in the one place a spinner is most visible.
 *
 * Everything else is genuinely a second step -- a nav click, or a page behind
 * sign-in -- and can afford to be fetched at the moment it is wanted.
 */
import Home from './pages/Home.jsx';
import SignIn from './pages/SignIn.jsx';

const Features = lazy(() => import('./pages/Features.jsx'));
const Pricing = lazy(() => import('./pages/Pricing.jsx'));
const HowItWorks = lazy(() => import('./pages/HowItWorks.jsx'));
const CaseStudies = lazy(() => import('./pages/CaseStudies.jsx'));
const Contact = lazy(() => import('./pages/Contact.jsx'));
const Download = lazy(() => import('./pages/Download.jsx'));
const Privacy = lazy(() => import('./pages/Privacy.jsx'));
const Terms = lazy(() => import('./pages/Terms.jsx'));
const SignUp = lazy(() => import('./pages/SignUp.jsx'));
const OnboardingOrg = lazy(() => import('./pages/OnboardingOrg.jsx'));
const Upload = lazy(() => import('./pages/Upload.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));

export default function App() {
  const location = useLocation();
  // Routes that own the whole viewport and supply their own way back — the
  // dashboard has its sidebar, sign-in has a wordmark linking home. Wrapping
  // either in marketing chrome puts a "Get Started" button above a form the
  // visitor is already using.
  const CHROMELESS = ['/dashboard', '/signin', '/signup', '/onboarding', '/upload'];
  // The desktop app has no marketing pages, so its root IS sign-in and must be
  // chromeless too — otherwise the window opens with a nav bar advertising the
  // product to someone who already bought it.
  const isChromeless = CHROMELESS.includes(location.pathname)
    || (isDesktop && location.pathname === '/');

  return (
    <>
      <ScrollToTop />
      <DesktopIntro />
      {!isChromeless && <Navbar />}
      <main>
        {/* One boundary around the whole switch rather than one per route:
            only ever a single page is resolving, and the fallback is the same
            wait either way. */}
        <Suspense fallback={(
          <div className="flex min-h-screen items-center justify-center px-7 py-24">
            <LoadingState sub="Loading." />
          </div>
        )}
        >
          <Routes>
            {/* Someone who installed the app has already been sold to. The
                website keeps its homepage; the app opens on the door — and
                DesktopRoot checks whether that door is already unlocked before
                asking anyone for a key. */}
            <Route path="/" element={isDesktop ? <DesktopRoot /> : <Home />} />
            <Route path="/features" element={<Features />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/how-it-works" element={<HowItWorks />} />
            <Route path="/case-studies" element={<CaseStudies />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/download" element={<Download />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/signin" element={<SignIn />} />
            <Route path="/onboarding" element={<RequireAuth><OnboardingOrg /></RequireAuth>} />
            <Route path="/upload" element={<RequireAuth><Upload /></RequireAuth>} />
            <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          </Routes>
        </Suspense>
      </main>
      {!isChromeless && <Footer />}
    </>
  );
}
