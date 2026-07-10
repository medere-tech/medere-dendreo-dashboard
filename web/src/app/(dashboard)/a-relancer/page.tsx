import { RelanceView } from '@/components/relance/relance-view';

export default function ARelancerPage() {
  return (
    <section>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">À relancer</h1>
        <p className="mt-1 text-sm text-muted">
          Toutes les attestations non signées, toutes sessions (hors « Echec ») - plus anciennes d&apos;abord.
        </p>
      </div>

      <RelanceView />
    </section>
  );
}
