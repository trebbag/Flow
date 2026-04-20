import type { ComponentType } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";
import { RootLayout } from "./components/layout";
import { RouteErrorBoundary } from "./components/route-error-boundary";
import { AppBootstrapProvider } from "./components/app-bootstrap";
import { BootstrapLoadingScreen } from "./components/bootstrap-loading-screen";
import { SectionErrorBoundary } from "./components/section-error-boundary";

function RouteHydrateFallback() {
  return <BootstrapLoadingScreen phase="session_restoration" />;
}

function withSectionBoundary<T extends object>(
  section: string,
  Component: ComponentType<T>,
) {
  return function SectionWrapped(props: T) {
    return (
      <SectionErrorBoundary section={section}>
        <Component {...props} />
      </SectionErrorBoundary>
    );
  };
}

const router = createBrowserRouter([
  {
    path: "/login",
    errorElement: <RouteErrorBoundary />,
    hydrateFallbackElement: <RouteHydrateFallback />,
    lazy: async () => ({
      Component: (await import("./components/login-view")).LoginView,
    }),
  },
  {
    path: "/auth/callback",
    errorElement: <RouteErrorBoundary />,
    hydrateFallbackElement: <RouteHydrateFallback />,
    lazy: async () => ({
      Component: (await import("./components/auth-callback-view")).AuthCallbackView,
    }),
  },
  {
    path: "/",
    Component: RootLayout,
    errorElement: <RouteErrorBoundary />,
    hydrateFallbackElement: <RouteHydrateFallback />,
    children: [
      {
        index: true,
        lazy: async () => ({
          Component: (await import("./components/overview-page")).OverviewPage,
        }),
      },
      {
        path: "checkin",
        lazy: async () => ({
          Component: (await import("./components/checkin-view")).CheckInView,
        }),
      },
      {
        path: "ma-board",
        lazy: async () => ({
          Component: (await import("./components/ma-board-view")).MABoardView,
        }),
      },
      {
        path: "clinician",
        lazy: async () => ({
          Component: (await import("./components/clinician-view")).ClinicianView,
        }),
      },
      {
        path: "rooms",
        lazy: async () => ({
          Component: (await import("./components/rooms-view")).RoomsView,
        }),
      },
      {
        path: "checkout",
        lazy: async () => ({
          Component: (await import("./components/checkout-view")).CheckOutView,
        }),
      },
      {
        path: "office-manager",
        lazy: async () => ({
          Component: (await import("./components/office-manager-dashboard")).OfficeManagerDashboard,
        }),
      },
      {
        path: "revenue-cycle",
        lazy: async () => ({
          Component: withSectionBoundary(
            "Revenue Cycle",
            (await import("./components/revenue-cycle-view")).RevenueCycleView,
          ),
        }),
      },
      {
        path: "closeout",
        lazy: async () => ({
          Component: (await import("./components/closeout-view")).CloseoutView,
        }),
      },
      {
        path: "encounter/:id",
        lazy: async () => ({
          Component: withSectionBoundary(
            "Encounter Detail",
            (await import("./components/encounter-detail-view")).EncounterDetailView,
          ),
        }),
      },
      {
        path: "analytics",
        lazy: async () => ({
          Component: withSectionBoundary(
            "Analytics",
            (await import("./components/analytics-view")).AnalyticsView,
          ),
        }),
      },
      {
        path: "alerts",
        lazy: async () => ({
          Component: (await import("./components/alerts-view")).AlertsView,
        }),
      },
      {
        path: "tasks",
        lazy: async () => ({
          Component: (await import("./components/tasks-view")).TasksView,
        }),
      },
      {
        path: "settings",
        lazy: async () => ({
          Component: withSectionBoundary(
            "Admin Console",
            (await import("./components/admin-console")).AdminConsole,
          ),
        }),
      },
      {
        path: "*",
        lazy: async () => ({
          Component: (await import("./components/not-found")).NotFound,
        }),
      },
    ],
  },
]);

export default function App() {
  return (
    <AppBootstrapProvider>
      <RouterProvider router={router} />
    </AppBootstrapProvider>
  );
}
