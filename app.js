/**
 * cPanel / Passenger entry point.
 *
 * cPanel's "Setup Node.js App" screen asks for an Application Startup File and
 * expects it at the application root. The actual server lives in server/, so
 * this hands off to it rather than duplicating anything.
 *
 * Keep this file trivial. Passenger loads it before the app has logging or
 * error handling of its own, so anything that throws here fails with a stack
 * trace in a log the operator may not know how to reach. `npm start` runs the
 * same file by a different route -- both end up in server/index.js, which is
 * where every real decision is made.
 */

require('./server/index.js');
