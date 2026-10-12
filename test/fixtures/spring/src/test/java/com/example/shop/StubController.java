package com.example.shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

// a controller of the tests: not a route of the application
@RestController
public class StubController {

    @GetMapping("/only-in-tests")
    public String stub() {
        return "";
    }
}
