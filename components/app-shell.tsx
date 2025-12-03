"use client";

import { ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { signOut } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase/auth";

export default function AppShell({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();

    return (
        <div className="dashboard">
            <aside
                className="sidebar"
                style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    height: '100vh',
                    overflow: 'hidden',
                }}
            >
                <div className="sidebar__brand">
                    <span className="sidebar__tag">{new Date().toLocaleDateString()}</span>
                </div>
                <div
                    className="sidebar__nav"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        height: 'calc(100vh - 64px)',
                        gap: '0.5rem',
                        justifyContent: 'space-between',
                    }}
                >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <button
                            type="button"
                            className={`sidebar__btn${pathname === '/' ? ' sidebar__btn--active' : ''}`}
                            onClick={() => router.push('/')}
                        >
                            🏠  Home
                        </button>
                        <button
                            type="button"
                            className={`sidebar__btn${pathname === '/clients' ? ' sidebar__btn--active' : ''}`}
                            onClick={() => router.push('/clients')}
                        >
                            👤  Clients
                        </button>
                    </div>
                    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <button
                            type="button"
                            className="sidebar__btn"
                            onClick={() => router.push('/?showKeys=1')}
                        >
                            🔑  Keys
                        </button>
                        <button
                            type="button"
                            className="sidebar__btn"
                            onClick={async () => {
                                try {
                                    await signOut(firebaseAuth);
                                    router.replace('/auth');
                                } catch (err) {
                                    console.warn('Logout failed', err);
                                }
                            }}
                        >
                            🚪  Logout
                        </button>
                    </div>
                </div>
            </aside>

            <div className="dashboard__inner" style={{ marginLeft: '260px' }}>
                <div className="dashboard__content">{children}</div>
            </div>
        </div>
    );
}