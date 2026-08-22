import { type CompletionDurabilityProvider, type CompletionDurabilityRegistry, type CompletionDurabilityRegistryListener, type CompletionDurabilityRegistrySnapshot } from "../public/v1/completion-durability.ts";
export declare class CompletionDurabilityRegistryImpl implements CompletionDurabilityRegistry {
    #private;
    current(): CompletionDurabilityProvider | undefined;
    snapshot(): CompletionDurabilityRegistrySnapshot;
    register(provider: CompletionDurabilityProvider): () => void;
    subscribe(listener: CompletionDurabilityRegistryListener): () => void;
}
export declare function getCompletionDurabilityRegistry(root?: object): CompletionDurabilityRegistry;
