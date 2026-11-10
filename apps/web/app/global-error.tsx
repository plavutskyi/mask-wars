'use client';

import { hubot, mona } from './fonts';
import './globals.css';

// The whole site failed to draw, layout included: the same screen as any other error, with nothing it could depend on.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className={`${hubot.variable} ${mona.variable}`}>
      <body>
        <main className="nf-screen">
          <div className="nf-body">
            <svg className="nf-mark" viewBox="0 0 240 280" aria-hidden focusable="false">
              <path
                fill="currentColor"
                d="M47 0 L120 87 L193 0 L224 95 L138 155 L138 179 L214 126 L164 280 L120 228 L76 280 L26 126 L102 179 L102 155 L16 95Z"
              />
            </svg>
            <h1 className="nf-title">MASK WARS tripped</h1>
            <div className="nf-acts">
              <button type="button" className="nf-btn" onClick={reset}>
                Try again
              </button>
              <a href="/" className="nf-quiet">
                To the race
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
