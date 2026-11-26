//
//  HeraTodayBundle.swift
//  HeraToday
//
//  Created by Nathaniel on 11/8/26.
//

import WidgetKit
import SwiftUI

@main
struct HeraTodayBundle: WidgetBundle {
    var body: some Widget {
        HeraToday()
        #if os(iOS)
        // Scheduled posts counting down on the Lock Screen and in the Dynamic Island.
        ScheduledPostLiveActivity()
        #endif
    }
}
