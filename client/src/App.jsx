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
import Terms from './pages/Terms.jsx';


export default function App() {
  const location = useLocation();
  const isDashboard = location.pathname === '/dashboard';

  return (
    <>
      <ScrollToTop />
      {!isDashboard && <Navbar />}
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/features" element={<Features />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/case-studies" element={<CaseStudies />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/signin" element={<SignIn />} />
          <Route path="/onboarding" element={<RequireAuth><OnboardingOrg /></RequireAuth>} />
          <Route path="/upload" element={<RequireAuth><Upload /></RequireAuth>} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        </Routes>
      </main>
      {!isDashboard && <Footer />}
    </>
  );
}
