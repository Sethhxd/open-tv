import { Directive, ElementRef, EventEmitter, OnDestroy, OnInit, Output } from "@angular/core";

/** Emits once when the element first scrolls into (or near) view. */
@Directive({ selector: "[appInView]" })
export class InViewDirective implements OnInit, OnDestroy {
  @Output() appInView = new EventEmitter<void>();
  private observer?: IntersectionObserver;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnInit() {
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          this.observer?.disconnect();
          this.appInView.emit();
        }
      },
      { rootMargin: "200px" },
    );
    this.observer.observe(this.el.nativeElement);
  }

  ngOnDestroy() {
    this.observer?.disconnect();
  }
}
