'use client';

import { useEffect, useState } from 'react';
import { msUntilNextParisMidnight, todayInParis } from '@/lib/time';

/**
 * Date du jour à Paris ("YYYY-MM-DD"), re-calculée PILE au prochain minuit Paris
 * (timer léger, re-programmé à chaque passage). Ainsi une session qui finit
 * aujourd'hui apparaît dans le cockpit à 00h, sans rechargement.
 */
export function useParisToday(): string {
  const [today, setToday] = useState<string>(() => todayInParis());

  useEffect(() => {
    let timer: number;
    function schedule() {
      const delay = msUntilNextParisMidnight() + 1000; // petit tampon après minuit
      timer = window.setTimeout(() => {
        setToday(todayInParis());
        schedule();
      }, delay);
    }
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  return today;
}
