import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight">PaperPilot</h1>
      <p className="text-base text-slate-600">
        TypeScript 移行プロトタイプ（CSP 検証用の最小構成）。
      </p>
      <Link
        href="/themes/"
        className="inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        テーマ一覧へ
      </Link>
    </main>
  );
}
