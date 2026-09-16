/**
 * 카카오 지도 SDK를 대신하는 최소 구현. page.addInitScript로 넣는다.
 *
 * 왜 필요한가: 지도 타일은 카카오 서버에서 오고 개발·테스트 환경에는 지도 키가 없다.
 * react-kakao-maps-sdk는 window.kakao.maps가 이미 있으면 스크립트를 내려받지 않고 그대로 쓰므로(Loader.addLoadEventLisnter),
 * 마커가 실제로 그려지는지·누르면 어디로 가는지를 네트워크 없이 확인할 수 있다.
 * 좌표 → 화면 위치 변환은 실제 투영법이 아니라 선형 근사다: 마커의 존재·선택·겹침 처리를 보는 용도다.
 */
export function installKakaoMapStub(): void {
  const PX_PER_DEG_AT_LEVEL_3 = 91_000;

  class LatLng {
    constructor(
      private readonly lat: number,
      private readonly lng: number,
    ) {}
    getLat(): number {
      return this.lat;
    }
    getLng(): number {
      return this.lng;
    }
    equals(other: LatLng): boolean {
      return other instanceof LatLng && other.getLat() === this.lat && other.getLng() === this.lng;
    }
  }

  class Coords {
    constructor(
      private readonly x: number,
      private readonly y: number,
    ) {}
    toLatLng(): LatLng {
      return new LatLng(this.y, this.x);
    }
  }

  class LatLngBounds {
    minLat = Number.POSITIVE_INFINITY;
    maxLat = Number.NEGATIVE_INFINITY;
    minLng = Number.POSITIVE_INFINITY;
    maxLng = Number.NEGATIVE_INFINITY;
    extend(point: LatLng): void {
      this.minLat = Math.min(this.minLat, point.getLat());
      this.maxLat = Math.max(this.maxLat, point.getLat());
      this.minLng = Math.min(this.minLng, point.getLng());
      this.maxLng = Math.max(this.maxLng, point.getLng());
    }
    isEmpty(): boolean {
      return !Number.isFinite(this.minLat);
    }
  }

  const listeners = new WeakMap<object, Map<string, Set<() => void>>>();

  class StubMap {
    readonly layer: HTMLElement;
    private center: LatLng;
    private level: number;
    constructor(
      private readonly container: HTMLElement,
      options: { center: LatLng; level?: number },
    ) {
      container.style.position = 'relative';
      container.style.overflow = 'hidden';
      container.style.background = '#e7ece9';
      this.layer = document.createElement('div');
      this.layer.setAttribute('data-kakao-stub-layer', '');
      this.layer.style.cssText = 'position:absolute;inset:0;';
      container.appendChild(this.layer);
      this.center = options.center;
      this.level = options.level ?? 3;
      this.redraw();
    }
    setCenter(center: LatLng): void {
      this.center = center;
      this.redraw();
    }
    getCenter(): LatLng {
      return this.center;
    }
    panTo(center: LatLng): void {
      this.setCenter(center);
    }
    setLevel(level: number): void {
      this.level = level;
      this.redraw();
    }
    getLevel(): number {
      return this.level;
    }
    setBounds(bounds: LatLngBounds, top = 0, right = 0, bottom = 0, left = 0): void {
      if (bounds.isEmpty()) return;
      this.center = new LatLng((bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2);
      const width = Math.max(1, this.container.clientWidth - left - right);
      const height = Math.max(1, this.container.clientHeight - top - bottom);
      const needed = Math.min(width / Math.max(0.02, bounds.maxLng - bounds.minLng), height / Math.max(0.02, bounds.maxLat - bounds.minLat));
      this.level = Math.min(14, Math.max(1, Math.ceil(3 + Math.log2(PX_PER_DEG_AT_LEVEL_3 / needed))));
      this.redraw();
    }
    getProjection(): { containerPointFromCoords: (point: LatLng) => { x: number; y: number } } {
      return { containerPointFromCoords: (point: LatLng) => this.toPixel(point) };
    }
    toPixel(point: LatLng): { x: number; y: number } {
      const scale = PX_PER_DEG_AT_LEVEL_3 / 2 ** (this.level - 3);
      return {
        x: this.container.clientWidth / 2 + (point.getLng() - this.center.getLng()) * scale,
        y: this.container.clientHeight / 2 - (point.getLat() - this.center.getLat()) * scale,
      };
    }
    redraw(): void {
      window.setTimeout(() => {
        this.layer.querySelectorAll('[data-kakao-stub-overlay]').forEach((element) => {
          const place = (element as HTMLElement & { place?: () => void }).place;
          if (place) place();
        });
        listeners.get(this)?.get('idle')?.forEach((handler) => handler());
      }, 0);
    }
    // 쓰지 않는 설정 메서드 (react-kakao-maps-sdk가 prop이 있을 때만 부른다)
    setDraggable(): void {}
    setZoomable(): void {}
    setKeyboardShortcuts(): void {}
    setMapTypeId(): void {}
    setProjectionId(): void {}
    setMinLevel(): void {}
    setMaxLevel(): void {}
    relayout(): void {}
    addControl(): void {}
    removeControl(): void {}
  }

  class StubCustomOverlay {
    private readonly content: HTMLElement;
    private readonly wrapper: HTMLElement & { place?: () => void };
    private map: StubMap | null = null;
    private position: LatLng;
    constructor(options: { content: HTMLElement; position: LatLng; xAnchor?: number; yAnchor?: number; zIndex?: number }) {
      this.content = options.content;
      this.position = options.position;
      this.wrapper = document.createElement('div');
      this.wrapper.setAttribute('data-kakao-stub-overlay', '');
      const xAnchor = options.xAnchor ?? 0.5;
      const yAnchor = options.yAnchor ?? 0.5;
      this.wrapper.style.cssText = `position:absolute;transform:translate(${-xAnchor * 100}%,${-yAnchor * 100}%);z-index:${options.zIndex ?? 0};`;
      this.wrapper.appendChild(this.content);
      this.wrapper.place = () => this.place();
      // 이 시점에 parentElement가 있어야 react-kakao-maps-sdk가 자식을 포털로 그린다.
      document.body.appendChild(this.wrapper);
    }
    getContent(): HTMLElement {
      return this.content;
    }
    setMap(map: StubMap | null): void {
      this.map = map;
      if (map === null) {
        this.wrapper.remove();
        return;
      }
      map.layer.appendChild(this.wrapper);
      this.place();
    }
    setPosition(position: LatLng): void {
      this.position = position;
      this.place();
    }
    setZIndex(zIndex: number): void {
      this.wrapper.style.zIndex = String(zIndex);
    }
    place(): void {
      if (this.map === null) return;
      const point = this.map.toPixel(this.position);
      this.wrapper.style.left = `${point.x}px`;
      this.wrapper.style.top = `${point.y}px`;
    }
  }

  const maps = {
    load: (callback: () => void) => callback(),
    LatLng,
    Coords,
    LatLngBounds,
    Map: StubMap,
    CustomOverlay: StubCustomOverlay,
    MapTypeId: { ROADMAP: 1, SKYVIEW: 2, HYBRID: 3 },
    ControlPosition: { TOP: 1, TOPRIGHT: 2, RIGHT: 3 },
    event: {
      addListener(target: object, type: string, handler: () => void) {
        const byType = listeners.get(target) ?? new Map<string, Set<() => void>>();
        listeners.set(target, byType);
        const handlers = byType.get(type) ?? new Set<() => void>();
        byType.set(type, handlers);
        handlers.add(handler);
      },
      removeListener(target: object, type: string, handler: () => void) {
        listeners.get(target)?.get(type)?.delete(handler);
      },
    },
  };

  (window as unknown as { kakao: unknown }).kakao = { maps };
}
