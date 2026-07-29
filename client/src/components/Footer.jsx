import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="shell">
        <div className="footer-top">
          <div className="footer-brand">
            <div className="brand">
              <span className="brand-mark">Rx</span>
              RxNaija Analytics
            </div>
            <p>Pharmacy business intelligence for the Nigerian counter. Built in Lagos.</p>
          </div>

          <div className="footer-col">
            <h4>Product</h4>
            <ul>
              <li><Link to="/features">Features</Link></li>
              <li><Link to="/pricing">Pricing</Link></li>
              <li><Link to="/how-it-works">How It Works</Link></li>
              <li><Link to="/case-studies">Case Studies</Link></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>Company</h4>
            <ul>
              <li><Link to="/contact">Contact</Link></li>
              <li><Link to="/privacy">Privacy Policy</Link></li>
              <li><Link to="/terms">Terms of Use</Link></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>Get started</h4>
            <ul>
              <li><a href="#trial">Start free trial</a></li>
              <li><Link to="/contact">Talk to us</Link></li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <span>© 2026 RxNaija Analytics. All rights reserved.</span>
          <span>Prices exclude VAT · No card required for trial</span>
        </div>
      </div>
    </footer>
  );
}
