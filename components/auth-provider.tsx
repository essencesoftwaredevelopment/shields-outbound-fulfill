"use client";

import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { getAccessToken } from "@/lib/supabase/session";

interface AuthContextValue {
    user: User | null;
    session: Session | null;
    loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ user: null, session: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        supabase.auth.getSession().then(({ data }) => {
            setSession(data.session ?? null);
            setUser(data.session?.user ?? null);
            setLoading(false);
        });

        const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
            // Token refresh on tab focus updates the session only — avoid re-running
            // data effects keyed on `user` when the signed-in identity is unchanged.
            if (event === "TOKEN_REFRESHED") {
                setSession(nextSession);
                setLoading(false);
                return;
            }
            setSession(nextSession);
            const nextUser = nextSession?.user ?? null;
            setUser((prev) => {
                if (!nextUser && !prev) return null;
                if (nextUser?.id === prev?.id) return prev;
                return nextUser;
            });
            setLoading(false);
        });

        // Chrome throttles timers in background tabs, so the hourly JWT can expire
        // while we are away. Refresh on return instead of sending the user to /auth.
        const onVisible = () => {
            if (document.visibilityState === "visible") {
                void getAccessToken();
            }
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            sub.subscription.unsubscribe();
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    const value = useMemo(() => ({ user, session, loading }), [user, session, loading]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
    return useContext(AuthContext);
}
