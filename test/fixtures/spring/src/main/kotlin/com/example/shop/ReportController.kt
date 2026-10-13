package com.example.shop

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/reports")
class ReportController(private val service: ReportService) {

    @GetMapping("/daily")
    fun daily(@RequestParam day: String, @RequestParam("tz") zone: String?): Report = service.daily(day, zone)

    @PostMapping(value = ["/rebuild"])
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun rebuild() {
        service.rebuild()
    }
}
