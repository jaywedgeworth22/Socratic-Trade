#if DEBUG
import Foundation

extension MobileStore {
    static var preview: MobileStore {
        MobileStore(
            client: MobileAPIClient(baseURL: MobileAPIClient.configuredBaseURL),
            previewSnapshot: PreviewFixtures.snapshot
        )
    }
}

enum PreviewFixtures {
    static let snapshot: MobileSnapshot = {
        let data = Data(snapshotJSON.utf8)
        return try! JSONDecoder().decode(MobileSnapshot.self, from: data)
    }()

    private static let snapshotJSON = #"""
    {
      "currentUser": {"userId":"preview","email":"jay@example.com","name":"Jay","loginProvider":"apple"},
      "readiness": {
        "hasAccount":true,
        "hasUniverse":true,
        "systemState":"active",
        "strategyAuthority":"propose",
        "selectedAccountNumber":"••4812",
        "activeConnectedAccount":{"id":"account-1","label":"Primary Brokerage","broker":"robinhood","environment":"live","accountNumber":"••4812","isActive":true},
        "commandBacklog":{"queued":0,"running":0}
      },
      "policy": {
        "systemState":"active",
        "strategyAuthority":"propose",
        "holdingHorizon":"swing",
        "runCadenceMinutes":30,
        "maxOrderNotional":2500,
        "maxDailyNotional":10000,
        "maxDailyOrders":8,
        "requireTypedConfirmation":true
      },
      "marketSession":"regular",
      "scheduler":{"lastRunAt":"2026-07-21T17:15:00.000Z","nextRunAt":"2026-07-21T17:45:00.000Z"},
      "portfolio":{"accountNumber":"••4812","totalMarketValue":42150.25,"buyingPower":10680.50,"equityMarketValue":35900.00,"optionMarketValue":0,"cash":6250.25},
      "positions":[
        {"symbol":"AAPL","quantity":42,"marketValue":8962.80,"averageCost":198.20,"sector":"Technology"},
        {"symbol":"NVDA","quantity":18,"marketValue":3294.00,"averageCost":171.50,"sector":"Technology"}
      ],
      "orders":[
        {"id":"order-1","symbol":"AAPL","side":"sell","type":"limit","state":"queued","quantity":10,"limitPrice":220,"createdAt":"2026-07-21T16:55:00.000Z"}
      ],
      "pendingProposals":[
        {"id":"proposal-1","createdAt":"2026-07-21T17:20:00.000Z","accountNumber":"••4812","executionMode":"broker/live","estimatedNotional":1875,"performanceSinceProposalPct":1.2,"proposal":{"symbol":"MSFT","side":"buy","type":"limit","quantity":4,"limitPrice":468.75,"rationale":"Durable earnings revision and improving breadth support a measured entry.","tradeThesisTag":"quality momentum","entryMarketRegime":"risk-on","confidenceScore":78}}
      ],
      "dailyStats":{"orderCount":2,"openingOrderCount":1,"notional":1875},
      "performance":{"liveRealizedPnl":524.18,"paperRealizedPnl":0,"liveUnrealizedPnl":184.30,"paperUnrealizedPnl":0,"liveWinRate":62.5,"paperWinRate":0,"liveAverageReturnPct":2.4,"paperAverageReturnPct":0,"benchmark":{"accountReturnPct":8.4,"benchmarkReturnPct":6.9,"excessReturnPct":1.5,"startDate":"2026-06-01","endDate":"2026-07-21","points":31,"benchmarkSymbol":"SPY"},"fills":[]},
      "connectedAccounts":[{"id":"account-1","label":"Primary Brokerage","broker":"robinhood","environment":"live","accountNumber":"••4812","isActive":true}],
      "watchlist":[{"symbol":"TSLA","addedAt":"2026-07-20T15:00:00.000Z"},{"symbol":"META","addedAt":"2026-07-20T15:05:00.000Z"}],
      "alerts":[{"id":"alert-1","symbol":"NVDA","op":">","price":190,"note":"Breakout level","status":"armed","createdAt":"2026-07-20T15:10:00.000Z"}],
      "notifications":[
        {"id":"note-1","createdAt":"2026-07-21T17:18:00.000Z","type":"pending_approval","title":"Buy MSFT Awaiting Approval","body":"Sent","read":false,"connectedAccountId":"account-1","accountLabel":"Primary Brokerage"},
        {"id":"note-2","createdAt":"2026-07-21T16:40:00.000Z","type":"fill","title":"Bought AAPL","body":"Sent","read":true,"connectedAccountId":"account-1","accountLabel":"Primary Brokerage"}
      ],
      "recentCommands":[{"id":"command-1","commandType":"strategy.run_once","status":"succeeded","createdAt":"2026-07-21T17:15:00.000Z","updatedAt":"2026-07-21T17:16:00.000Z"}]
    }
    """#
}
#endif
