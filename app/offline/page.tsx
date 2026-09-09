import Image from "next/image";
import Link from "next/link";

export default function OfflinePage() {
  return (
    <main className="offline-page">
      <div className="offline-card">
        <Image src="/pwa-icon.svg" alt="" width={56} height={56} priority />
        <p className="eyebrow">Shields Outbound</p>
        <h1>You&apos;re offline</h1>
        <p>Reconnect to load your latest clients, leads, and campaign data.</p>
        <Link href="/">Try again</Link>
      </div>
    </main>
  );
}
