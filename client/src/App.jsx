import { Routes, Route, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import ScrollToTop from './components/ScrollToTop.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Home from './pages/Home.jsx';
import Features from './pages/Features.jsx';
import Pricing from './pages/Pricing.jsx';
import HowItWorks from './pages/HowItWorks.jsx';
import CaseStudies from './pages/CaseStudies.jsx';
import Contact from './pages/Contact.jsx';
import Upload from './pages/Upload.jsx';
import Dashboard from './pages/Dashboard.jsx';
import SignUp from './pages/SignUp.jsx';
import SignIn from './pages/SignIn.jsx';
import OnboardingOrg from './pages/OnboardingOrg.jsx';
import Privacy from './pages/Privacy.jsx';
import Download from './pages/Download.jsx';
import Terms from './pages/Terms.jsx';
import DesktopIntro from './components/DesktopIntro.jsx';
import { isDesktop } from './lib/platform.js';


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
        <Routes>
          {/* Someone who installed the app has already been sold to. The
              website keeps its homepage; the app opens on the door. */}
          <Route path="/" element={isDesktop ? <SignIn /> : <Home />} />
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
      </main>
      {!isChromeless && <Footer />}
    </>
  );
}
