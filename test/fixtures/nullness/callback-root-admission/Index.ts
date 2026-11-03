declare function register(callback: () => void): void;

export function activeRegistration(): void {
    register(() => {
        const value: string | null = null;
        value!.trim();
    });
}

export function inactiveRegistration(): void {
    register(() => {
        const value: string | null = null;
        value!.trim();
    });
}

export function cleanRegistration(): void {
    register(() => {
        const value: string = 'safe';
        value.trim();
    });
}
