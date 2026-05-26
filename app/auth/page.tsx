"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export default function AuthPage() {
    const router = useRouter();
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setIsSubmitting(true);
        setError(null);

        try {
            if (mode === "signin") {
                const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
                if (signInError) throw signInError;
            } else {
                const { error: signUpError } = await supabase.auth.signUp({ email, password });
                if (signUpError) throw signUpError;
            }
            router.replace("/");
        } catch (authError) {
            setError(authError instanceof Error ? authError.message : "Authentication failed");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="auth-shell">
            <form className="auth-card" onSubmit={handleSubmit}>
                <div>
                    <p className="eyebrow">Shield&apos;s Outbound</p>
                    <h1 className="auth-card__title">{mode === "signin" ? "Sign in" : "Create account"}</h1>
                    <p className="auth-card__subtitle">Get ready to scale</p>
                </div>

                {error && <p className="auth-card__error">{error}</p>}

                <label className="settings-field">
                    <span className="settings-field__label">Email</span>
                    <input
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                    />
                </label>
                <label className="settings-field">
                    <span className="settings-field__label">Password</span>
                    <input
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                    />
                </label>

                <button type="submit" className="primary-button" disabled={isSubmitting}>
                    {isSubmitting ? "Working..." : mode === "signin" ? "Sign In" : "Create Account"}
                </button>

                <button
                    type="button"
                    className="auth-card__switch"
                    onClick={() => setMode((prev) => (prev === "signin" ? "signup" : "signin"))}
                >
                    {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
                </button>
            </form>
        </div>
    );
}
