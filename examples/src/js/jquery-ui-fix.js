(function($)
{
    $.fn.input = function (css)
    {
        if (!css) css = {};
        return this.each(function ()
        {
            $(this).addClass("ui-widget ui-widget-content ui-corner-all ui-input");
            $(this).css(css);
        });
    }
})(jQuery);

(function ($)
{
    $.fn.label = function (css)
    {
        if (!css) css = {};
        return this.each(function ()
        {
            $(this).addClass("ui-widget ui-input");
            $(this).css(css);
        });
    }
})(jQuery);