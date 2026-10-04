import { Suspense } from "react";
import { ThemesClient } from "../../components/themes/ThemesClient";

/**
 * Server component wrapping the real client component in a Suspense
 * boundary, which `useSearchParams` requires under static export (Next
 * bails the build otherwise). `?theme=` is intentionally read client-
 * side rather than via a per-slug static route -- see the P2 brief:
 * "no per-theme static generation", so adding a new theme never needs
 * a full site rebuild.
 */
export default function ThemesPage() {
  return (
    <main id="main-content">
      <Suspense
        fallback={
          <div className="px-4 py-16 text-center text-sm text-ink-subtle sm:px-6" role="status">
            読み込み中…
          </div>
        }
      >
        <ThemesClient />
      </Suspense>
    </main>
  );
}
