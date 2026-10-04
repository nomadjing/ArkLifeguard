declare namespace http { interface HttpRequest { destroy(): void; } function createHttp(): HttpRequest; } export default http;
