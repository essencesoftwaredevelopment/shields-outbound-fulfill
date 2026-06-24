"use client";

import { FormEvent, InputHTMLAttributes, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

const MIN_PASSWORD_LENGTH = 8;

function getAuthCallbackUrl() {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/auth/callback`;
}

function validatePassword(password: string): string | null {
    if (password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return null;
}

function PasswordInput({
    visible,
    onToggleVisible,
    ...props
}: InputHTMLAttributes<HTMLInputElement> & {
    visible: boolean;
    onToggleVisible: () => void;
}) {
    return (
        <div className="password-field">
            <input {...props} type={visible ? "text" : "password"} />
            <button
                type="button"
                className="password-field__toggle"
                onClick={onToggleVisible}
                aria-label={visible ? "Hide password" : "Show password"}
                tabIndex={-1}
            >
                {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
            </button>
        </div>
    );
}

export default function AuthPage() {
    const router = useRouter();
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
    const [showResendConfirmation, setShowResendConfirmation] = useState(false);
    const [showPasswords, setShowPasswords] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const callbackError = params.get("error");
        const confirmed = params.get("confirmed");
        if (callbackError === "confirmation_failed") {
            setError("Email confirmation link is invalid or expired. Request a new one below.");
            setShowResendConfirmation(true);
            setMode("signin");
        }
        if (confirmed === "1") {
            setNotice("Email confirmed. You can sign in now.");
            setMode("signin");
        }
    }, []);

    const resetFormMessages = () => {
        setError(null);
        setNotice(null);
        setAwaitingConfirmation(false);
    };

    const handleModeSwitch = () => {
        resetFormMessages();
        setConfirmPassword("");
        setShowPasswords(false);
        setMode((prev) => (prev === "signin" ? "signup" : "signin"));
    };

    const handleResendConfirmation = async () => {
        if (!email.trim()) {
            setError("Enter your email address first.");
            return;
        }
        setIsSubmitting(true);
        setError(null);
        setNotice(null);
        try {
            const { error: resendError } = await supabase.auth.resend({
                type: "signup",
                email: email.trim(),
                options: { emailRedirectTo: getAuthCallbackUrl() },
            });
            if (resendError) throw resendError;
            setNotice("Confirmation email sent. Check your inbox.");
        } catch (resendErr) {
            setError(resendErr instanceof Error ? resendErr.message : "Failed to resend confirmation email.");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setIsSubmitting(true);
        setError(null);
        setNotice(null);
        setAwaitingConfirmation(false);

        try {
            if (mode === "signin") {
                const { error: signInError } = await supabase.auth.signInWithPassword({
                    email: email.trim(),
                    password,
                });
                if (signInError) throw signInError;
                router.replace("/");
                return;
            }

            const passwordError = validatePassword(password);
            if (passwordError) {
                setError(passwordError);
                return;
            }
            if (password !== confirmPassword) {
                setError("Passwords do not match.");
                return;
            }

            const { data, error: signUpError } = await supabase.auth.signUp({
                email: email.trim(),
                password,
                options: { emailRedirectTo: getAuthCallbackUrl() },
            });
            if (signUpError) throw signUpError;

            if (data.session) {
                router.replace("/");
                return;
            }

            setAwaitingConfirmation(true);
            setShowResendConfirmation(true);
            setNotice("Check your email for a confirmation link before signing in.");
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
                    <p className="auth-card__subtitle">
                        {mode === "signup"
                            ? "Create an agency account to manage your outbound clients."
                            : "Get ready to scale"}
                    </p>
                </div>

                {error && <p className="auth-card__error">{error}</p>}
                {notice && <p className="auth-card__notice">{notice}</p>}

                <label className="settings-field">
                    <span className="settings-field__label">Email</span>
                    <input
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        autoComplete="email"
                        required
                    />
                </label>
                <label className="settings-field">
                    <span className="settings-field__label">Password</span>
                    <PasswordInput
                        placeholder="••••••••"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete={mode === "signup" ? "new-password" : "current-password"}
                        minLength={mode === "signup" ? MIN_PASSWORD_LENGTH : undefined}
                        visible={showPasswords}
                        onToggleVisible={() => setShowPasswords((prev) => !prev)}
                        required
                    />
                    {mode === "signup" && (
                        <span className="settings-field__hint">At least {MIN_PASSWORD_LENGTH} characters</span>
                    )}
                </label>
                {mode === "signup" && (
                    <label className="settings-field">
                        <span className="settings-field__label">Confirm password</span>
                        <PasswordInput
                            placeholder="••••••••"
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            autoComplete="new-password"
                            minLength={MIN_PASSWORD_LENGTH}
                            visible={showPasswords}
                            onToggleVisible={() => setShowPasswords((prev) => !prev)}
                            required
                        />
                    </label>
                )}

                <button type="submit" className="primary-button" disabled={isSubmitting}>
                    {isSubmitting ? "Working..." : mode === "signin" ? "Sign In" : "Create Account"}
                </button>

                {(awaitingConfirmation || showResendConfirmation) && (
                    <button
                        type="button"
                        className="auth-card__switch"
                        onClick={handleResendConfirmation}
                        disabled={isSubmitting}
                    >
                        Resend confirmation email
                    </button>
                )}

                <button type="button" className="auth-card__switch" onClick={handleModeSwitch}>
                    {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
                </button>
            </form>
        </div>
    );
}
