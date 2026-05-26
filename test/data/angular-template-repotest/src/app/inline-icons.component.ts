import { Component } from "@angular/core";

@Component({
  selector: "app-inline-icons",
  template: `<i class="pi pi-home"></i><i class="bi bi-gear"></i><i class="fas fa-user"></i>`,
})
export class InlineIconsComponent {
  treeNode = {
    icon: "pi pi-fw pi-folder",
    expandedIcon: "pi pi-folder-open",
    collapsedIcon: "pi pi-folder",
  };
}
