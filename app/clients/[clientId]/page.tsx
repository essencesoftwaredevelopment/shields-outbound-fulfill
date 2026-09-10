import { Suspense } from "react";
import ClientPage from "./client-page";
import { ClientWorkspaceFallback } from "./client-workspace-fallback";

export default function ClientRoutePage() {
    return (
        <Suspense fallback={<ClientWorkspaceFallback />}>
            <ClientPage />
        </Suspense>
    );
}
